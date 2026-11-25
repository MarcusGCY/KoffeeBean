import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approvalRoute } from "@/app/api/demo/pelita/approval/route";
import { POST as listingRoute } from "@/app/api/demo/pelita/listing/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { POST as stockCheckRoute } from "@/app/api/demo/pelita/stock-check/route";
import { evalFenced } from "./helpers/fake-redis-eval";
import { PelitaAuditTimeline } from "@/components/pelita-ops/PelitaAuditTimeline";
import { approveLaunch, approveSourcing } from "@/lib/demo/approval";
import { launchPhase } from "@/lib/demo/approval-view";
import { AUDIT_FOOTER, auditView } from "@/lib/demo/audit-view";
import { defaultListingDeps, runListingDraft, sendForApproval } from "@/lib/demo/listing";
import { ensureOpeningRows, findDetectionRow, openingFixtureRows } from "@/lib/demo/opening";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { detectionToLive, durationLabel, publishedView } from "@/lib/demo/published-view";
import { loadScenario } from "@/lib/demo/scenario";
import { STATE_KEYS, getDemoSnapshot, getDemoState, resetDemo, setElapsedMode, type DemoAuditRow, type ElapsedMode } from "@/lib/demo/state";
import { continueFromStockCheck, defaultStockCheckDeps, runStockCheck } from "@/lib/demo/stock-check";

const cookieJar: { value: string | undefined } = { value: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.value && name === PRESENTER_COOKIE ? { name, value: cookieJar.value } : undefined),
  }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

type Command = (string | number)[];

const SECRET = "test-approval-secret";
const ENV_KEYS = ["KB_DEMO_TRACK", "VERCEL_ENV", "APPROVAL_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
const ROOT = path.resolve(__dirname, "..");
const PREFIX = "kb:demo:pelita:";
const FOREIGN = { "kb:chat:h:user-1": "7", "kb:demo:other": "keep" };

const scenario = loadScenario();
const [first, second] = [...scenario.approvers].sort((a, b) => a.slot - b.slot);
const instant = async () => undefined;
const at = (iso: string) => new Date(iso);
const T_OPEN = at("2026-11-25T01:02:10.000Z");
const T1 = at("2026-11-25T01:03:35.000Z");
const T_SEND = at("2026-11-25T01:06:50.000Z");
const T2 = at("2026-11-25T01:09:05.000Z");

let store: Map<string, string | string[]>;
let expiring: Set<string>;
let urls: string[];
let sent: Command[];
let evals: Command[];
let failNext: ((commands: Command[], url: string) => boolean) | null;

/** A Redis with real NX semantics. Each request waits a tick first, so simultaneous requests really interleave. */
function execute(commands: Command[]): unknown[] {
  return commands.map((command) => {
    if (command[0] === "EVAL") {
      evals.push(command);
      return evalFenced(command, (key) => store.get(key) as string | undefined, (inner) => execute([inner])[0] as { result?: unknown; error?: string });
    }
    sent.push(command);
    const [name, k, ...rest] = command as [string, string, ...(string | number)[]];
    switch (name) {
      case "GET":
        return { result: (store.get(k) as string | undefined) ?? null };
      case "SET": {
        const options = rest.slice(1).map((o) => String(o).toUpperCase());
        if (options.includes("NX") && store.has(k)) return { result: null };
        store.set(k, String(rest[0]));
        if (options.includes("EX")) expiring.add(k);
        return { result: "OK" };
      }
      case "DEL":
        return { result: store.delete(k) ? 1 : 0 };
      case "RPUSH": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        list.push(String(rest[0]));
        store.set(k, list);
        return { result: list.length };
      }
      case "LRANGE": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        const stop = Number(rest[1]);
        return { result: list.slice(Number(rest[0]), stop < 0 ? list.length + stop + 1 : stop + 1) };
      }
      default:
        return { error: `unsupported ${name}` };
    }
  });
}

function useFakeRedis() {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as Command[];
      urls.push(String(url));
      await new Promise((resolve) => setImmediate(resolve));
      if (failNext?.(commands, String(url))) {
        failNext = null;
        return new Response("down", { status: 500 });
      }
      return Response.json(execute(commands));
    }),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = SECRET;
  cookieJar.value = signPresenterToken(SECRET);
}

function post(url: string, body: unknown): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://x.test",
    cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}`,
  });
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

const approvalCall = (action: string, approverId: string, confirmed = true) =>
  approvalRoute(post("https://x.test/api/demo/pelita/approval", { action, approverId, confirmed }));
const stockCall = (action: "run" | "continue") => stockCheckRoute(post("https://x.test/api/demo/pelita/stock-check", { action }));
const listingCall = (body: Record<string, unknown>) => listingRoute(post("https://x.test/api/demo/pelita/listing", body));

const rowsOf = (list: unknown) => ((list as string[] | undefined) ?? []).map((row) => JSON.parse(row) as DemoAuditRow);
const auditRows = () => rowsOf(store.get(`${PREFIX}audit`));
const openingRowsNow = async (opened: Date | null = null) => {
  const { state, epoch } = await getDemoSnapshot();
  return ensureOpeningRows(scenario, state, epoch, opened ?? undefined);
};
const demoKeys = () => [...store.keys()].filter((k) => k.startsWith(PREFIX));

async function toScreen05(): Promise<void> {
  await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
  await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
  await continueFromStockCheck(scenario);
  await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
  await sendForApproval(scenario, { approverId: first.id }, T_SEND);
}

beforeEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  store = new Map(Object.entries(FOREIGN));
  expiring = new Set();
  urls = [];
  sent = [];
  evals = [];
  failNext = null;
  useFakeRedis();
});

afterEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  vi.unstubAllGlobals();
});

describe("approval slot compare-and-set", () => {
  it("lets exactly one of two simultaneous approvals for the same slot through, and refuses the second", async () => {
    const results = await Promise.all([
      approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1),
      approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "already_approved" }]);

    const rows = auditRows();
    expect(rows.filter((r) => r.ref === scenario.sourcing.approvalId)).toHaveLength(1);
    expect(Object.keys(JSON.parse(store.get(`${PREFIX}approvals`) as string))).toEqual(["sourcing"]);
  });

  it("lets exactly one of several simultaneous approval 2 requests publish, once", async () => {
    await toScreen05();
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill({ ok: false, reason: "already_approved" }));

    const rows = auditRows();
    expect(rows.filter((r) => r.ref === scenario.launchApproval.approvalId)).toHaveLength(1);
    expect(rows.filter((r) => r.actorKind === "system")).toHaveLength(1);
    expect(await getDemoState()).toMatchObject({ listed: true, stage: 6 });
  });

  it("answers 200 to one and 409 already_approved to the other when two requests hit the approval route together", async () => {
    openGate();
    const responses = await Promise.all([approvalCall("approve_sourcing", first.id), approvalCall("approve_sourcing", first.id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    expect(await loser.json()).toEqual({ error: "already_approved" });
    expect(auditRows().filter((r) => r.actorKind === "human")).toHaveLength(1);

    await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
    await continueFromStockCheck(scenario);
    await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    const launch = await Promise.all([approvalCall("approve_launch", second.id), approvalCall("approve_launch", second.id)]);
    expect(launch.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(auditRows().filter((r) => r.ref === scenario.launchApproval.approvalId)).toHaveLength(1);
  });

  it("claims the slot on its own key inside the prefix, writes the approval in one fenced script, and reset clears the claim", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    expect(store.get(`${PREFIX}claim:sourcing`)).toBe("approve");
    expect(expiring.has(`${PREFIX}claim:sourcing`)).toBe(true);
    expect(sent.find((c) => c[0] === "SET" && c[1] === `${PREFIX}claim:sourcing`)).toEqual(["SET", `${PREFIX}claim:sourcing`, "approve", "NX", "EX", 60]);
    const writes = evals.filter((c) => c.includes("RPUSH"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(expect.arrayContaining(["SET", `${PREFIX}approvals`, "RPUSH", `${PREFIX}audit`]));

    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(STATE_KEYS).toContain(target);
    }
    await resetDemo();
    expect(demoKeys().sort()).toEqual([`${PREFIX}epoch`, `${PREFIX}listed`, `${PREFIX}stage`]);
    for (const [k, v] of Object.entries(FOREIGN)) expect(store.get(k)).toBe(v);
    expect((await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1)).ok).toBe(true);
  });

  it("releases the claim when the write fails, so the same approver can try again", async () => {
    failNext = (commands) => commands.some((c) => c[0] === "EVAL" && c.includes("RPUSH"));
    await expect(approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1)).rejects.toThrow();
    expect(store.has(`${PREFIX}claim:sourcing`)).toBe(false);
    expect(store.has(`${PREFIX}approvals`)).toBe(false);
    expect(auditRows()).toEqual([]);

    expect((await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1)).ok).toBe(true);
    expect(auditRows()).toHaveLength(1);
  });

  it("still refuses a second approval after the claim has expired, because the approval itself is checked", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    store.delete(`${PREFIX}claim:sourcing`);
    expect(await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1)).toEqual({ ok: false, reason: "already_approved" });
    expect(auditRows()).toHaveLength(1);
  });

  it("claims each slot separately, so approval 1 never blocks approval 2", async () => {
    await toScreen05();
    expect(store.has(`${PREFIX}claim:launch`)).toBe(false);
    expect((await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).ok).toBe(true);
    expect([`${PREFIX}claim:sourcing`, `${PREFIX}claim:launch`].every((k) => store.has(k))).toBe(true);
  });
});

describe("approval 2 cannot skip the stock check or the listing draft through the API", () => {
  async function snapshot() {
    return { state: await getDemoState(), keys: JSON.stringify([...store.entries()].filter(([k]) => k.startsWith(PREFIX)).sort()) };
  }

  it("refuses a direct approve_launch at every earlier step, writes nothing, and only publishes after the draft is sent", async () => {
    openGate();
    const attempt = async (expected: { status: number; error: string }) => {
      const before = await snapshot();
      const res = await approvalCall("approve_launch", second.id);
      expect({ status: res.status, body: await res.json() }).toEqual({ status: expected.status, body: { error: expected.error } });
      const after = await snapshot();
      expect(after.keys).toBe(before.keys);
      expect(after.state.approvals.launch).toBeUndefined();
      expect(after.state.listed).toBe(false);
      expect(after.state.audit.some((r) => r.actorKind === "system")).toBe(false);
    };

    await attempt({ status: 409, error: "sourcing_required" });

    expect((await approvalCall("approve_sourcing", first.id)).status).toBe(200);
    await attempt({ status: 409, error: "stock_check_required" });

    expect((await stockCall("run")).status).toBe(200);
    await attempt({ status: 409, error: "stock_check_required" });

    expect((await stockCall("continue")).status).toBe(200);
    await attempt({ status: 409, error: "listing_required" });

    expect((await listingCall({ action: "draft" })).status).toBe(200);
    await attempt({ status: 409, error: "listing_required" });

    expect((await listingCall({ action: "send", approverId: first.id })).status).toBe(200);
    const published = await approvalCall("approve_launch", second.id);
    expect(published.status).toBe(200);
    expect(await getDemoState()).toMatchObject({ listed: true, stage: 6 });
  });

  it("cannot jump straight from sourcing to sending: send needs a draft, and a draft needs the stock check", async () => {
    openGate();
    expect((await approvalCall("approve_sourcing", first.id)).status).toBe(200);

    const noCheck = await listingCall({ action: "draft" });
    expect(noCheck.status).toBe(409);
    expect(await noCheck.json()).toEqual({ error: "stock_check_required" });
    const sendNoCheck = await listingCall({ action: "send", approverId: first.id });
    expect(sendNoCheck.status).toBe(409);
    expect(await sendNoCheck.json()).toEqual({ error: "stock_check_required" });

    expect((await stockCall("run")).status).toBe(200);
    expect((await stockCall("continue")).status).toBe(200);
    const sendNoDraft = await listingCall({ action: "send", approverId: first.id });
    expect(sendNoDraft.status).toBe(409);
    expect(await sendNoDraft.json()).toEqual({ error: "draft_required" });
    const late = await approvalCall("approve_launch", second.id);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "listing_required" });
    expect((await getDemoState()).approvals.launch).toBeUndefined();
  });

  it("does not let the first approver stand in for the second at any of those steps", async () => {
    openGate();
    expect((await approvalCall("approve_sourcing", first.id)).status).toBe(200);
    for (const approverId of [first.id, "nobody"]) {
      const res = await approvalCall("approve_launch", approverId);
      expect([400, 403]).toContain(res.status);
    }
    expect((await getDemoState()).approvals.launch).toBeUndefined();
  });
});

describe("opening agent rows", () => {
  const loadOps = async () => (await import("@/app/demo/pelita/ops/page")).default;
  async function renderOps() {
    const Page = await loadOps();
    return renderToStaticMarkup(await Page());
  }

  it("writes the spotted-the-gap and proposed-the-listing rows once, from the fixture, on the first load", async () => {
    openGate();
    await renderOps();
    const rows = auditRows();
    const fixture = openingFixtureRows(scenario);
    expect(fixture.map((r) => r.action)).toEqual([scenario.audit[0].action, scenario.audit[1].action]);
    expect(rows).toHaveLength(2);
    rows.forEach((row, i) => {
      const { actorKind, actor, action, source, ref } = fixture[i];
      expect(row).toMatchObject({ actorKind, actor, action, source, ref });
      expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    });
    expect(rows.map((r) => r.actorKind)).toEqual(["agent", "agent"]);
    expect(rows.map((r) => r.ref)).toEqual([scenario.gap.id, scenario.gap.id]);
  });

  it("does not write them again on reloads", async () => {
    openGate();
    for (let i = 0; i < 4; i++) await renderOps();
    expect(auditRows()).toHaveLength(2);
    expect(await getDemoState()).toMatchObject({ stage: 0, approvals: {}, listed: false });
  });

  it("writes them once when many loads arrive together", async () => {
    openGate();
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => renderOps()));
    expect(auditRows()).toHaveLength(2);
    const direct = await Promise.all([1, 2, 3].map(() => ensureOpeningRows(scenario, { audit: [] }, "0", T_OPEN)));
    expect(direct.filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(auditRows()).toHaveLength(2);
  });

  it("only the winner of a simultaneous first load writes, and its two rows land in one transaction", async () => {
    const { epoch } = await getDemoSnapshot();
    const results = await Promise.all([1, 2, 3, 4].map(() => ensureOpeningRows(scenario, { audit: [] }, epoch, T_OPEN)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(auditRows().map((r) => r.at)).toEqual([T_OPEN.toISOString(), T_OPEN.toISOString()]);
    expect(evals.filter((c) => c.includes("RPUSH"))).toHaveLength(1);
  });

  it("writes them again after a reset, and only after a reset", async () => {
    openGate();
    await renderOps();
    expect((await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined))).status).toBe(200);
    expect(auditRows()).toEqual([]);
    expect(store.has(`${PREFIX}opening`)).toBe(false);
    await renderOps();
    await renderOps();
    expect(auditRows()).toHaveLength(2);
  });

  it("leaves a trail that already has other rows alone, and never writes while an approval is under way", async () => {
    openGate();
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await renderOps();
    expect(auditRows()).toHaveLength(1);
    expect(auditRows().some((r) => r.actorKind === "agent")).toBe(false);
  });

  it("releases its guard when the write fails, so the next load writes them, and a failing store never breaks the page", async () => {
    openGate();
    failNext = (commands) => commands.some((c) => c[0] === "EVAL" && c.includes("RPUSH"));
    const html = await renderOps();
    expect(html).toContain("data-ops-console");
    expect(auditRows()).toEqual([]);
    expect(store.has(`${PREFIX}opening`)).toBe(false);
    await renderOps();
    expect(auditRows()).toHaveLength(2);
  });

  it("renders screen 01 as a new proposal without the store configured", async () => {
    openGate();
    delete process.env.UPSTASH_REDIS_REST_URL;
    expect(await renderOps()).toContain('data-proposal-status="new"');
  });

  it("counts the two rows as agent steps on the audit timeline, in the order they were written", async () => {
    openGate();
    await renderOps();
    const view = auditView(scenario, await getDemoState());
    expect(view.agent.count).toBe(2);
    expect(view.entries.map((e) => e.action)).toEqual(openingFixtureRows(scenario).map((r) => r.action));
  });
});

describe("detection-to-live time (screens 06 and 07)", () => {
  async function runFull(opened: Date | null, published: Date, mode: ElapsedMode = "real") {
    await setElapsedMode(mode);
    if (opened) await openingRowsNow(opened);
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
    await continueFromStockCheck(scenario);
    await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    const result = await approveLaunch(scenario, { approverId: second.id, confirmed: true }, published);
    return { result, state: { ...(await getDemoState()), elapsedMode: mode } };
  }

  it("formats whole minutes and seconds the way the fixture does", () => {
    expect(durationLabel(scenario.timing.totalSeconds)).toBe(scenario.timing.totalLabel);
    expect(durationLabel(45)).toBe("45 s");
    expect(durationLabel(60)).toBe("1 min 0 s");
    expect(durationLabel(95.4)).toBe("1 min 35 s");
  });

  it("measures the pill and the live-in line from the real first row to the real publish row", async () => {
    const { result, state } = await runFull(T_OPEN, new Date(T_OPEN.getTime() + 95_000));
    expect(detectionToLive(scenario, state)).toEqual({ seconds: 95, label: "1 min 35 s", fromRows: true });
    expect(auditView(scenario, state).elapsed).toEqual({ pill: "1 min 35 s, gap to live", detail: "Live in about 2 minutes" });
    expect(publishedView(scenario, state)).toMatchObject({ liveIn: "Live in about 2 minutes", liveInDetail: "1 min 35 s from detection to live" });
    expect(result).toMatchObject({ ok: true, published: { liveIn: "Live in about 2 minutes", liveInDetail: "1 min 35 s from detection to live" } });
  });

  it("reads a gap under a minute as seconds, and never rounds the live-in line below one minute", async () => {
    const { state } = await runFull(T_OPEN, new Date(T_OPEN.getTime() + 45_000));
    expect(auditView(scenario, state).elapsed).toEqual({ pill: "45 s, gap to live", detail: "Live in about 1 minute" });
  });

  it("falls back to the fixture figure when the opening row is missing", async () => {
    const { state } = await runFull(null, T2);
    expect(findDetectionRow(scenario, state)).toBeNull();
    expect(detectionToLive(scenario, state)).toEqual({ seconds: scenario.timing.totalSeconds, label: scenario.timing.totalLabel, fromRows: false });
    expect(auditView(scenario, state).elapsed).toEqual({ pill: `${scenario.timing.totalLabel}, gap to live`, detail: "Live in about 7 minutes" });
    expect(publishedView(scenario, state)?.liveInDetail).toBe(`${scenario.timing.totalLabel} from detection to live`);
  });

  it("falls back to the fixture figure when the publish row is missing or the clock runs backwards", async () => {
    const { state } = await runFull(T_OPEN, T2);
    const withoutPublish = { ...state, audit: state.audit.filter((r) => r.actorKind !== "system") };
    expect(detectionToLive(scenario, withoutPublish).fromRows).toBe(false);
    expect(detectionToLive(scenario, withoutPublish).label).toBe(scenario.timing.totalLabel);

    const backwards = { ...state, audit: state.audit.map((r) => (r.actorKind === "system" ? { ...r, at: new Date(T_OPEN.getTime() - 1000).toISOString() } : r)) };
    expect(detectionToLive(scenario, backwards)).toMatchObject({ label: scenario.timing.totalLabel, fromRows: false });
    const garbled = { ...state, audit: state.audit.map((r) => (r.actorKind === "system" ? { ...r, at: "not a time" } : r)) };
    expect(detectionToLive(scenario, garbled).fromRows).toBe(false);
  });

  it("shows no elapsed time before the publish, and none after a reset", async () => {
    await openingRowsNow(T_OPEN);
    expect(auditView(scenario, await getDemoState()).elapsed).toBeNull();
    await runFull(null, T2);
    await resetDemo();
    expect(auditView(scenario, await getDemoState()).elapsed).toBeNull();
  });
});

describe("screen 07 footer", () => {
  it("is the SPEC wording and covers every step, not only those after the proposal", () => {
    expect(AUDIT_FOOTER).toBe("Nothing reaches shoppers without two human approvals. Every agent step is logged.");
    expect(AUDIT_FOOTER).not.toMatch(/after the proposal/);
    const html = renderToStaticMarkup(PelitaAuditTimeline({ view: auditView(scenario, { stage: 0, approvals: {}, audit: [], listed: false }) }));
    expect(html).toContain(AUDIT_FOOTER);
  });
});

describe("reset leaves nothing stale", () => {
  it("does not let a stock check that was running during a reset write its rows afterwards", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    const result = await runStockCheck(scenario, {
      ...defaultStockCheckDeps,
      wait: async () => {
        await resetDemo();
      },
    });
    expect(result).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
  });

  it("does not let a listing draft that was running during a reset write its rows afterwards", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
    await continueFromStockCheck(scenario);
    const result = await runListingDraft(scenario, {
      ...defaultListingDeps,
      wait: async () => {
        await resetDemo();
      },
    });
    expect(result).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
  });

  it("resets in one transaction and returns to a clean first screen, ready for the opening rows again", async () => {
    await toScreen05();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    await openingRowsNow(T_OPEN);
    urls = [];
    expect(await resetDemo()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(urls).toEqual([expect.stringMatching(/\/multi-exec$/)]);
    expect(launchPhase(scenario, await getDemoState())).toBe("sourcing_pending");
    expect(demoKeys().sort()).toEqual([`${PREFIX}epoch`, `${PREFIX}listed`, `${PREFIX}stage`]);
    for (const [k, v] of Object.entries(FOREIGN)) expect(store.get(k)).toBe(v);
    expect(await openingRowsNow(T_OPEN)).toBe(true);
  });

  it("makes the Reset button reload the ops console from the server instead of patching client state", () => {
    const text = readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaOpsConsole.tsx"), "utf8");
    expect(text).toMatch(/await resetDemoRequest\(\);[\s\S]*window\.location\.assign\(OPS_PATH\)/);
  });
});
