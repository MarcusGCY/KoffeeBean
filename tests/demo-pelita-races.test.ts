import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approvalRoute } from "@/app/api/demo/pelita/approval/route";
import { POST as elapsedRoute } from "@/app/api/demo/pelita/elapsed/route";
import { POST as proposalRoute } from "@/app/api/demo/pelita/proposal/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaAuditTimeline } from "@/components/pelita-ops/PelitaAuditTimeline";
import { approveLaunch, approveSourcing, sendBackLaunch } from "@/lib/demo/approval";
import { approvalView, findSendBack } from "@/lib/demo/approval-view";
import { auditView } from "@/lib/demo/audit-view";
import { defaultListingDeps, editListing, runListingDraft, sendForApproval } from "@/lib/demo/listing";
import { ensureOpeningRows } from "@/lib/demo/opening";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { findRejection } from "@/lib/demo/ops-console";
import { rejectProposal } from "@/lib/demo/proposal";
import { publishedView } from "@/lib/demo/published-view";
import { loadScenario } from "@/lib/demo/scenario";
import {
  STATE_KEYS,
  StaleEpochError,
  getDemoSnapshot,
  getDemoState,
  getElapsedMode,
  resetDemo,
  setElapsedMode,
  setStage,
  type DemoAuditRow,
  type ElapsedMode,
} from "@/lib/demo/state";
import { continueFromStockCheck, defaultStockCheckDeps, runStockCheck } from "@/lib/demo/stock-check";
import { storefrontView } from "@/lib/demo/storefront";
import { evalFenced } from "./helpers/fake-redis-eval";

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
const T_OPEN = at("2026-11-25T01:20:10.000Z");
const T1 = at("2026-11-25T01:21:35.000Z");
const T_SEND = at("2026-11-25T01:24:50.000Z");
const T2 = at("2026-11-25T01:21:45.000Z");

let store: Map<string, string | string[]>;
let sent: Command[];
let beforeRequest: ((commands: Command[]) => Promise<void>) | null;

function execute(commands: Command[]): unknown[] {
  return commands.map((command) => {
    if (command[0] === "EVAL") {
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
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as Command[];
      await new Promise((resolve) => setImmediate(resolve));
      await beforeRequest?.(commands);
      return Response.json(execute(commands));
    }),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = SECRET;
  cookieJar.value = signPresenterToken(SECRET);
}

function post(url: string, body: unknown, cookie: string | null = signPresenterToken(SECRET)): Request {
  const headers = new Headers({ "content-type": "application/json", origin: "https://x.test" });
  if (cookie) headers.set("cookie", `${PRESENTER_COOKIE}=${cookie}`);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

const rowsOf = (list: unknown) => ((list as string[] | undefined) ?? []).map((row) => JSON.parse(row) as DemoAuditRow);
const auditRows = () => rowsOf(store.get(`${PREFIX}audit`));
const demoKeys = () => [...store.keys()].filter((k) => k.startsWith(PREFIX)).sort();

const toApproved = () => approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
async function toChecked() {
  await toApproved();
  await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
  await continueFromStockCheck(scenario);
}
async function toDrafted() {
  await toChecked();
  await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
}
async function toScreen05() {
  await toDrafted();
  await sendForApproval(scenario, { approverId: first.id }, T_SEND);
}
async function openingRows(opened: Date) {
  const { state, epoch } = await getDemoSnapshot();
  return ensureOpeningRows(scenario, state, epoch, opened);
}

beforeEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  store = new Map(Object.entries(FOREIGN));
  sent = [];
  beforeRequest = null;
  useFakeRedis();
});

afterEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  vi.unstubAllGlobals();
});

describe("elapsed-time toggle", () => {
  async function runFull(mode: ElapsedMode | null, opened: Date | null) {
    if (mode) await setElapsedMode(mode);
    if (opened) await openingRows(opened);
    await toScreen05();
    const result = await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    const { state, elapsedMode } = await getDemoSnapshot();
    return { result, state: { ...state, elapsedMode } };
  }

  it("defaults to the fixture figure even when real rows exist, on screen 06 and 07", async () => {
    const { result, state } = await runFull(null, T_OPEN);
    expect(state.elapsedMode).toBe("fixture");
    const viewOf = auditView(scenario, state);
    expect(viewOf.elapsed).toEqual({ pill: `${scenario.timing.totalLabel}, gap to live`, detail: "Live in about 7 minutes" });
    expect(viewOf.detectedLabel).toBe(scenario.gap.detectedLabel);
    expect(result).toMatchObject({ ok: true, published: { liveIn: "Live in about 7 minutes", liveInDetail: `${scenario.timing.totalLabel} from detection to live` } });
    expect(approvalView(scenario, state).published).toMatchObject({ liveIn: "Live in about 7 minutes" });
    expect(storefrontView(scenario, { listed: true, published: publishedView(scenario, state) }).published?.toast).toMatchObject({ liveIn: "Live in about 7 minutes" });
  });

  it("follows the real rows when set to real: screen 06, the storefront, the screen 07 pill and its Detected label", async () => {
    const { result, state } = await runFull("real", T_OPEN);
    expect(state.elapsedMode).toBe("real");
    const viewOf = auditView(scenario, state);
    expect(viewOf.elapsed).toEqual({ pill: "1 min 35 s, gap to live", detail: "Live in about 2 minutes" });
    expect(viewOf.detectedLabel).toBe("Detected 09:20 today");
    expect(viewOf.detectedLabel).not.toBe(scenario.gap.detectedLabel);
    expect(result).toMatchObject({ ok: true, published: { liveIn: "Live in about 2 minutes", liveInDetail: "1 min 35 s from detection to live" } });
    expect(approvalView(scenario, state).published).toMatchObject({ liveIn: "Live in about 2 minutes" });
    expect(storefrontView(scenario, { listed: true, published: publishedView(scenario, state) }).published?.toast).toMatchObject({ liveIn: "Live in about 2 minutes" });
    const html = renderToStaticMarkup(PelitaAuditTimeline({ view: viewOf }));
    expect(html).toContain("Detected 09:20 today");
    expect(html).toContain("1 min 35 s, gap to live");
  });

  it("keeps the fixture Detected label in real mode when the opening row is missing", async () => {
    const { state } = await runFull("real", null);
    const viewOf = auditView(scenario, state);
    expect(viewOf.detectedLabel).toBe(scenario.gap.detectedLabel);
    expect(viewOf.elapsed?.pill).toBe(`${scenario.timing.totalLabel}, gap to live`);
  });

  it("is stored on its own key inside the prefix, read back, and restored to the fixture by reset", async () => {
    expect(await getElapsedMode()).toBe("fixture");
    await setElapsedMode("real");
    expect(store.get(`${PREFIX}elapsed`)).toBe("real");
    expect(STATE_KEYS).toContain(`${PREFIX}elapsed`);
    expect(await getElapsedMode()).toBe("real");
    await resetDemo();
    expect(store.has(`${PREFIX}elapsed`)).toBe(false);
    expect(await getElapsedMode()).toBe("fixture");
    for (const [k, v] of Object.entries(FOREIGN)) expect(store.get(k)).toBe(v);
  });

  it("reads anything but the exact word real as the fixture default", async () => {
    store.set(`${PREFIX}elapsed`, "REAL");
    expect(await getElapsedMode()).toBe("fixture");
    store.set(`${PREFIX}elapsed`, "garbage");
    expect((await getDemoSnapshot()).elapsedMode).toBe("fixture");
  });

  it("is presenter-only: no cookie or a bad cookie gets a 404 and writes nothing, a cross-site request a 403", async () => {
    openGate();
    const url = "https://x.test/api/demo/pelita/elapsed";
    expect((await elapsedRoute(post(url, { mode: "real" }, null))).status).toBe(404);
    expect((await elapsedRoute(post(url, { mode: "real" }, "forged"))).status).toBe(404);
    const cross = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` },
      body: JSON.stringify({ mode: "real" }),
    });
    expect((await elapsedRoute(cross)).status).toBe(403);
    expect(store.has(`${PREFIX}elapsed`)).toBe(false);
    expect(sent).toEqual([]);

    delete process.env.KB_DEMO_TRACK;
    expect((await elapsedRoute(post(url, { mode: "real" }))).status).toBe(404);
    expect(store.has(`${PREFIX}elapsed`)).toBe(false);
  });

  it("accepts only fixture or real, and the route sets and then reset clears it", async () => {
    openGate();
    const url = "https://x.test/api/demo/pelita/elapsed";
    for (const mode of ["", "REAL", "now", 5, null]) {
      const res = await elapsedRoute(post(url, { mode }));
      expect(res.status).toBe(400);
    }
    expect(store.has(`${PREFIX}elapsed`)).toBe(false);
    const ok = await elapsedRoute(post(url, { mode: "real" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ isDemo: true, elapsedMode: "real" });
    expect(store.get(`${PREFIX}elapsed`)).toBe("real");
    expect((await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined))).status).toBe(200);
    expect(await getElapsedMode()).toBe("fixture");
  });

  it("is on the screen 06/07 pages and the ops console, and the pages read it with the state", () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    for (const page of ["src/app/demo/pelita/ops/page.tsx", "src/app/demo/pelita/audit/page.tsx", "src/app/demo/pelita/page.tsx"]) {
      expect(read(page), page).toMatch(/getDemoSnapshot\(\)/);
      expect(read(page), page).toMatch(/elapsedMode/);
    }
    expect(read("src/app/api/demo/pelita/elapsed/route.ts")).toMatch(/guardDemoWrite\(req\)/);
    expect(read("src/components/pelita-ops/PelitaOpsConsole.tsx")).toMatch(/<PelitaElapsedToggle/);
    expect(read("src/components/pelita-ops/PelitaAuditTimeline.tsx")).toMatch(/<PelitaElapsedToggle/);
  });
});

describe("navy is for human approvals only (screen 07)", () => {
  const HUMAN_CLASS = /(^|[\s:])[\w-]*-human(-\d+)?(?=$|\s)/;
  const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col"]);

  /** Every element that carries a human (navy) class and is neither inside an approval row nor inside the approvals pill. */
  function strayNavy(html: string): string[] {
    const stray: string[] = [];
    const stack: boolean[] = [];
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
      const [, closing, tag, attrs, selfClosing] = match;
      if (closing) {
        stack.pop();
        continue;
      }
      const allowed = (stack[stack.length - 1] ?? false) || /data-human-kind="approval"/.test(attrs) || /data-approvals-pill/.test(attrs);
      const classes = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
      if (HUMAN_CLASS.test(classes) && !allowed) stray.push(`${tag} class="${classes}"`);
      if (!selfClosing && !VOID.has(tag)) stack.push(allowed);
    }
    return stray;
  }

  function fullView() {
    const rows = (over: Partial<DemoAuditRow>[]) => over.map((o, i) => ({ at: `2026-11-25T01:0${i}:00.000Z`, actorKind: "agent", actor: "Agent", action: "Did it", source: "S", ref: "X", ...o }) as DemoAuditRow);
    return auditView(scenario, {
      stage: 6,
      listed: true,
      approvals: {
        sourcing: { approverId: first.id, approvalId: scenario.sourcing.approvalId, at: "2026-11-25T01:03:00.000Z" },
        launch: { approverId: second.id, approvalId: scenario.launchApproval.approvalId, at: "2026-11-25T01:09:00.000Z" },
      },
      audit: rows([
        { actorKind: "agent" },
        { actorKind: "human", actor: first.name, action: "Approved sourcing", ref: scenario.sourcing.approvalId },
        { actorKind: "human", actor: first.name, action: "Sent for approval", ref: scenario.listing.id },
        { actorKind: "human", actor: second.name, action: "Approved launch", ref: scenario.launchApproval.approvalId },
        { actorKind: "system", actor: "Storefront", action: "Published", ref: scenario.audit.find((f) => f.actorKind === "system")?.ref ?? "P" },
      ]),
    });
  }

  it("keeps navy off the header avatar and the footer icon, and on only the approval rows and the approvals count", () => {
    const html = renderToStaticMarkup(PelitaAuditTimeline({ view: fullView() }));
    expect(html).toContain("data-approvals-pill");
    expect(html).toContain('data-human-kind="approval"');
    expect(strayNavy(html)).toEqual([]);
  });

  it("finds navy in the wrong place: the scan fails on a navy avatar, a navy footer icon and a navy non-approval row", () => {
    const html = renderToStaticMarkup(PelitaAuditTimeline({ view: fullView() }));
    const avatar = html.replace('rounded-full bg-ink text-[17px]', 'rounded-full bg-human text-[17px]');
    expect(avatar).not.toBe(html);
    expect(strayNavy(avatar)).toHaveLength(1);
    const footer = html.replace('<span class="text-ink-2">', '<span class="text-human">');
    expect(footer).not.toBe(html);
    expect(strayNavy(footer)).toHaveLength(1);
    const refCell = '<td class="whitespace-nowrap py-1 pr-1 text-base font-extrabold leading-6 text-ink">';
    const plainRow = html.replace(refCell, refCell.replace("text-ink", "text-human"));
    expect(plainRow).not.toBe(html);
    expect(strayNavy(plainRow)).toHaveLength(1);
  });

  it("holds with no approvals at all: only the zero count may be navy", () => {
    const html = renderToStaticMarkup(PelitaAuditTimeline({ view: auditView(scenario, { stage: 0, approvals: {}, audit: [], listed: false }) }));
    expect(strayNavy(html)).toEqual([]);
  });

  it("also holds in the source: the avatar is ink and the footer icon is neutral", () => {
    const text = readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaAuditTimeline.tsx"), "utf8");
    expect(text).not.toMatch(/rounded-full bg-human/);
    expect(text).toMatch(/<span className="text-ink-2">\s*<HumanIcon size=\{26\} \/>/);
  });
});

describe("send back and approve publish cannot both win the launch slot", () => {
  it("lets exactly one of a simultaneous approve_launch and send_back through, in either mix", async () => {
    for (const order of [["approve", "send"], ["send", "approve"]] as const) {
      await resetDemo();
      store.clear();
      for (const [k, v] of Object.entries(FOREIGN)) store.set(k, v);
      await toScreen05();
      const calls = order.map((kind) =>
        kind === "approve"
          ? approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)
          : sendBackLaunch(scenario, { approverId: second.id }, T2),
      );
      const [a, b] = await Promise.all(calls);
      const state = await getDemoState();
      const sentBack = findSendBack(scenario, state) !== null;
      const published = state.approvals.launch !== undefined;
      expect(sentBack !== published, `exactly one of send back or publish (${order.join("+")})`).toBe(true);
      expect(state.listed).toBe(published);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect(auditRows().filter((r) => r.ref === scenario.launchApproval.approvalId)).toHaveLength(published ? 1 : 0);
    }
  });

  it("refuses send back as already approved when approval 2 holds the launch guard, and writes nothing", async () => {
    await toScreen05();
    store.set(`${PREFIX}claim:launch`, "approve");
    const before = JSON.stringify(auditRows());
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toEqual({ ok: false, reason: "already_approved" });
    expect(JSON.stringify(auditRows())).toBe(before);
    expect(findSendBack(scenario, await getDemoState())).toBeNull();
  });

  it("refuses approval 2 as sent back when send back holds the launch guard, and publishes nothing", async () => {
    await toScreen05();
    store.set(`${PREFIX}claim:launch`, "send_back");
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "sent_back" });
    expect(await getDemoState()).toMatchObject({ listed: false });
    expect((await getDemoState()).approvals.launch).toBeUndefined();
  });

  it("takes the launch guard itself, with its own holder name, and a repeated send back stays a no-op", async () => {
    await toScreen05();
    const first1 = await sendBackLaunch(scenario, { approverId: second.id }, T2);
    expect(first1).toMatchObject({ ok: true, changed: true });
    expect(store.get(`${PREFIX}claim:launch`)).toBe("send_back");
    const again = await sendBackLaunch(scenario, { approverId: second.id }, T2);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(auditRows().filter((r) => r.action.startsWith("Sent back"))).toHaveLength(1);
  });

  it("releases the launch guard when the send back write fails, so approval 2 still works", async () => {
    await toScreen05();
    let failed = false;
    beforeRequest = async (commands) => {
      if (!failed && commands.some((c) => c[0] === "EVAL" && c.includes("RPUSH"))) {
        failed = true;
        throw new Error("down");
      }
    };
    await expect(sendBackLaunch(scenario, { approverId: second.id }, T2)).rejects.toThrow();
    expect(store.has(`${PREFIX}claim:launch`)).toBe(false);
    beforeRequest = null;
    expect((await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).ok).toBe(true);
  });
});

describe("reject and approve sourcing cannot both win the sourcing slot", () => {
  it("lets exactly one of a simultaneous reject and approve_sourcing through, in either order", async () => {
    for (const order of [["approve", "reject"], ["reject", "approve"]] as const) {
      store.clear();
      for (const [k, v] of Object.entries(FOREIGN)) store.set(k, v);
      await resetDemo();
      const calls = order.map((kind) => (kind === "approve" ? toApproved() : rejectProposal(scenario, T1)));
      await Promise.all(calls);
      const state = await getDemoState();
      const rejected = findRejection(scenario, state) !== null;
      const approved = state.approvals.sourcing !== undefined;
      expect(rejected !== approved, `exactly one of reject or approve (${order.join("+")})`).toBe(true);
      expect(auditRows().filter((r) => r.actorKind === "human")).toHaveLength(1);
    }
  });

  it("refuses the rejection as approved when approve sourcing holds the guard, and writes nothing", async () => {
    store.set(`${PREFIX}claim:sourcing`, "approve");
    expect(await rejectProposal(scenario, T1)).toEqual({ ok: false, status: "approved" });
    expect(auditRows()).toEqual([]);
  });

  it("refuses approve sourcing as rejected when reject holds the guard, and records no approval", async () => {
    store.set(`${PREFIX}claim:sourcing`, "reject");
    expect(await toApproved()).toEqual({ ok: false, reason: "proposal_rejected" });
    expect((await getDemoState()).approvals.sourcing).toBeUndefined();
  });

  it("takes the sourcing guard itself, a repeated reject is a no-op, and the route answers 409 when approval won", async () => {
    openGate();
    expect(await rejectProposal(scenario, T1)).toMatchObject({ ok: true, changed: true });
    expect(store.get(`${PREFIX}claim:sourcing`)).toBe("reject");
    expect(await rejectProposal(scenario, T1)).toMatchObject({ ok: true, changed: false });
    expect(auditRows()).toHaveLength(1);

    await resetDemo();
    await toApproved();
    const res = await proposalRoute(post("https://x.test/api/demo/pelita/proposal", { action: "reject" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_approved" });
  });

  it("releases the sourcing guard when the rejection write fails, so approval 1 still works", async () => {
    let failed = false;
    beforeRequest = async (commands) => {
      if (!failed && commands.some((c) => c[0] === "EVAL" && c.includes("RPUSH"))) {
        failed = true;
        throw new Error("down");
      }
    };
    await expect(rejectProposal(scenario, T1)).rejects.toThrow();
    expect(store.has(`${PREFIX}claim:sourcing`)).toBe(false);
    beforeRequest = null;
    expect((await toApproved()).ok).toBe(true);
  });
});

describe("a reset in the middle of a write drops that write (reset epoch)", () => {
  const CLEAN_KEYS = [`${PREFIX}epoch`, `${PREFIX}listed`, `${PREFIX}stage`];

  /** Runs `act`, and resets the demo just before the request that matches arrives at the store. */
  async function resetDuring(match: "first" | "write", act: () => Promise<unknown>) {
    let armed = true;
    beforeRequest = async (commands) => {
      const writing = commands.find((c) => c[0] === "EVAL" || (c[0] !== "GET" && c[0] !== "LRANGE"));
      if (!armed || !writing) return;
      if (match === "write" && !writing.includes("RPUSH")) return;
      armed = false;
      await resetDemo();
    };
    const outcome = await act().then(
      () => null,
      (error: unknown) => error,
    );
    beforeRequest = null;
    expect(armed, "the fenced request was reached").toBe(false);
    expect(outcome).toBeInstanceOf(StaleEpochError);
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(demoKeys()).toEqual(CLEAN_KEYS);
    for (const [k, v] of Object.entries(FOREIGN)) expect(store.get(k)).toBe(v);
  }

  const cases: { name: string; setup: () => Promise<unknown>; act: () => Promise<unknown>; match: "first" | "write" }[] = [
    { name: "approve sourcing, at its guard", setup: async () => undefined, act: toApproved, match: "first" },
    { name: "approve sourcing, at its commit", setup: async () => undefined, act: toApproved, match: "write" },
    { name: "reject, at its guard", setup: async () => undefined, act: () => rejectProposal(scenario, T1), match: "first" },
    { name: "reject, at its write", setup: async () => undefined, act: () => rejectProposal(scenario, T1), match: "write" },
    { name: "the opening rows, at their guard", setup: async () => undefined, act: () => openingRows(T_OPEN), match: "first" },
    { name: "the opening rows, at their write", setup: async () => undefined, act: () => openingRows(T_OPEN), match: "write" },
    {
      name: "the stock check",
      setup: toApproved,
      act: () => runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant }),
      match: "write",
    },
    {
      name: "continue from the stock check",
      setup: async () => {
        await toApproved();
        await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
      },
      act: () => continueFromStockCheck(scenario),
      match: "first",
    },
    { name: "the listing draft", setup: toChecked, act: () => runListingDraft(scenario, { ...defaultListingDeps, wait: instant }), match: "write" },
    {
      name: "a draft edit",
      setup: toDrafted,
      act: () => editListing(scenario, { approverId: first.id, description: "A softer, calmer blend of chamomile." }, T_SEND),
      match: "write",
    },
    { name: "send for approval", setup: toDrafted, act: () => sendForApproval(scenario, { approverId: first.id }, T_SEND), match: "write" },
    { name: "approve and publish, at its guard", setup: toScreen05, act: () => approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2), match: "first" },
    { name: "approve and publish, at its commit", setup: toScreen05, act: () => approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2), match: "write" },
    { name: "send back, at its guard", setup: toScreen05, act: () => sendBackLaunch(scenario, { approverId: second.id }, T2), match: "first" },
    { name: "send back, at its write", setup: toScreen05, act: () => sendBackLaunch(scenario, { approverId: second.id }, T2), match: "write" },
    { name: "the elapsed toggle", setup: async () => undefined, act: () => setElapsedMode("real", "0"), match: "first" },
    { name: "a bare stage move", setup: async () => undefined, act: () => setStage(3, "0"), match: "first" },
  ];

  for (const { name, setup, act, match } of cases) {
    it(`drops ${name}`, async () => {
      await setup();
      await resetDemo();
      await setup();
      // The act below starts from a request that began before the reset above.
      const { epoch } = await getDemoSnapshot();
      expect(epoch).not.toBe("0");
      await resetDuring(match, async () => {
        if (name === "the elapsed toggle") return setElapsedMode("real", epoch);
        if (name === "a bare stage move") return setStage(3, epoch);
        return act();
      });
    });
  }

  it("leaves no claim behind for the new epoch: after a stale guard attempt the next approval works", async () => {
    await resetDuring("first", toApproved);
    expect(store.has(`${PREFIX}claim:sourcing`)).toBe(false);
    expect((await toApproved()).ok).toBe(true);
  });

  it("changes the epoch on every reset and never deletes it, even on the first reset", async () => {
    expect((await getDemoSnapshot()).epoch).toBe("0");
    await resetDemo();
    const one = (await getDemoSnapshot()).epoch;
    await resetDemo();
    const two = (await getDemoSnapshot()).epoch;
    expect(one).not.toBe("0");
    expect(two).not.toBe(one);
    expect(sent.filter((c) => c[0] === "DEL" && c[1] === `${PREFIX}epoch`)).toEqual([]);
  });

  it("answers 409 reset_during_request from the routes when a reset lands mid-request, and the demo stays clean", async () => {
    openGate();
    let armed = true;
    beforeRequest = async (commands) => {
      if (armed && commands.some((c) => c[0] === "EVAL")) {
        armed = false;
        await resetDemo();
      }
    };
    const res = await approvalRoute(post("https://x.test/api/demo/pelita/approval", { action: "approve_sourcing", approverId: first.id, confirmed: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reset_during_request" });
    expect((await getDemoState()).approvals).toEqual({});

    armed = true;
    const elapsed = await elapsedRoute(post("https://x.test/api/demo/pelita/elapsed", { mode: "real" }));
    expect(elapsed.status).toBe(409);
    expect(await getElapsedMode()).toBe("fixture");
  });

  it("still lets a request that began after the reset write normally", async () => {
    await resetDemo();
    expect((await toApproved()).ok).toBe(true);
    expect(auditRows()).toHaveLength(1);
  });
});
