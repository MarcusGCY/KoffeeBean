import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as readState } from "@/app/api/demo/pelita/state/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaLaunchApproval } from "@/components/pelita-ops/PelitaLaunchApproval";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { PelitaAuditTimeline } from "@/components/pelita-ops/PelitaAuditTimeline";
import { pelitaPageAllowed } from "@/lib/demo/access";
import { SEND_BACK_ACTION_PREFIX, approvalView } from "@/lib/demo/approval-view";
import { REJECT_ACTION_PREFIX, opsConsoleView } from "@/lib/demo/ops-console";
import { publishedView } from "@/lib/demo/published-view";
import { storefrontView } from "@/lib/demo/storefront";
import { approveLaunch, approveSourcing, sendBackLaunch } from "@/lib/demo/approval";
import { AUDIT_FOOTER, approvalRef, approvalRefs, auditView, clockSecondsLabel } from "@/lib/demo/audit-view";
import { EDIT_ACTION_PREFIX, SEND_ACTION } from "@/lib/demo/listing-view";
import { defaultListingDeps, editListing, runListingDraft, sendForApproval } from "@/lib/demo/listing";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario } from "@/lib/demo/scenario";
import { STATE_KEYS, STATE_KEY_NAMES, getDemoState, type DemoAuditRow, type DemoState } from "@/lib/demo/state";
import { continueFromStockCheck, defaultStockCheckDeps, runStockCheck } from "@/lib/demo/stock-check";
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
const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};
const AUDIT_FILES = [
  "src/lib/demo/audit-view.ts",
  "src/lib/demo/audit-links.ts",
  "src/components/pelita-ops/PelitaAuditTimeline.tsx",
  "src/app/demo/pelita/audit/page.tsx",
];

let store: Map<string, string | string[]>;
let sent: Command[];

function fakeRedis(commands: Command[]): unknown[] {
  return commands.map((command) => {
    if (command[0] === "EVAL") return evalFenced(command, (key) => store.get(key) as string | undefined, (inner) => fakeRedis([inner])[0] as { result?: unknown; error?: string });
    sent.push(command);
    const [name, k, ...rest] = command as [string, string, ...(string | number)[]];
    switch (name) {
      case "GET":
        return { result: (store.get(k) as string | undefined) ?? null };
      case "SET":
        store.set(k, String(rest[0]));
        return { result: "OK" };
      case "DEL":
        return { result: store.delete(k) ? 1 : 0 };
      case "RPUSH": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        list.push(String(rest[0]));
        store.set(k, list);
        return { result: list.length };
      }
      case "LRANGE":
        return { result: (store.get(k) as string[] | undefined) ?? [] };
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
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(fakeRedis(JSON.parse(String(init?.body)) as Command[]))),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = SECRET;
  cookieJar.value = signPresenterToken(SECRET);
}

const scenario = loadScenario();
const renderTimeline = (view: ReturnType<typeof auditView>) => renderToStaticMarkup(createElement(PelitaAuditTimeline, { view }));
const [first, second] = [...scenario.approvers].sort((a, b) => a.slot - b.slot);
const T1 = new Date("2026-11-25T01:03:35.000Z");
const T_DRAFT = new Date("2026-11-25T01:06:20.000Z");
const T_EDIT = new Date("2026-11-25T01:07:10.000Z");
const T_SEND = new Date("2026-11-25T01:07:50.000Z");
const T2 = new Date("2026-11-25T01:09:05.000Z");
const instant = async () => undefined;

async function toLaunched(): Promise<void> {
  await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
  await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
  await continueFromStockCheck(scenario);
  await runListingDraft(scenario, { ...defaultListingDeps, wait: instant, now: () => T_DRAFT });
  await editListing(scenario, { approverId: first.id, description: "Gentle magnesium. Supports restful sleep. Vegan." }, T_EDIT);
  await sendForApproval(scenario, { approverId: first.id }, T_SEND);
  await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
}

/** The fixture's own audit rows as a persisted state, so the timeline can be checked without any flow. */
function fixtureState(overrides: Partial<DemoState> = {}): DemoState {
  return { stage: 6, approvals: {}, audit: scenario.audit.map((row) => ({ ...row })), listed: false, ...overrides };
}

const row = (extra: Partial<DemoAuditRow>): DemoAuditRow => ({
  at: "2026-11-25T01:10:00.000Z",
  actorKind: "human",
  actor: `${first.name} · ${first.role}`,
  action: "x",
  source: "Ops console",
  ref: null,
  ...extra,
});

const approvalOf = (approverId: string, approvalId: string, at = T1.toISOString()) => ({ approvalId, approverId, at });

beforeEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  store = new Map(Object.entries(FOREIGN));
  sent = [];
});

afterEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  vi.unstubAllGlobals();
});

describe("the audit timeline view model", () => {
  it("lists every audit row in order, with the actor kind and the time in Singapore time", () => {
    const view = auditView(scenario, fixtureState());
    expect(view.entries.map((e) => e.kind)).toEqual(scenario.audit.map((r) => r.actorKind));
    expect(view.entries.map((e) => e.timeLabel)).toEqual(["09:02:10", "09:02:40", "09:03:35", "09:04:15", "09:04:42", "09:05:30", "09:06:20", "09:09:05", "09:09:21"]);
    expect(view.entries.map((e) => [e.actor, e.action, e.source, e.ref])).toEqual(scenario.audit.map((r) => [r.actor, r.action, r.source, r.ref]));
    expect(view.entries[3].ref).toBeNull();
    expect(view.title).toBe("Audit trail · Magnesium Glycinate");
    expect(view.unavailable).toBe(false);
  });

  it("reads a UTC timestamp as Singapore time, whatever zone the server runs in", () => {
    expect(clockSecondsLabel("2026-11-25T01:02:10.000Z")).toBe("09:02:10");
    expect(clockSecondsLabel("2026-11-24T16:00:00.000Z")).toBe("00:00:00");
    expect(clockSecondsLabel("2026-11-25T09:02:10+08:00")).toBe("09:02:10");
    expect(clockSecondsLabel("not a time")).toBe("—");
    expect(clockSecondsLabel(undefined)).toBe("—");
  });

  it("shows the removed claim as before and after, from the claims row", () => {
    const view = auditView(scenario, fixtureState());
    const claims = view.entries.find((e) => e.ref === scenario.claimsCheck.id);
    expect(claims?.change).toEqual({
      label: "Claim",
      before: scenario.claimsCheck.removed.map((r) => r.claim).join(", "),
      after: scenario.claimsCheck.kept.join(", "),
      note: scenario.claimsCheck.removed.map((r) => r.reason).join(", "),
    });
    expect(claims?.change?.before).toBe(scenario.claimsCheck.removed[0].claim);
    expect(view.entries.filter((e) => e.change !== null)).toHaveLength(1);
  });

  it("shows each description edit as the previous wording to the new wording", () => {
    const view = auditView(
      scenario,
      fixtureState({
        audit: [
          row({ at: "2026-11-25T01:07:00.000Z", action: `${EDIT_ACTION_PREFIX}: One capsule a day.`, ref: scenario.listing.id }),
          row({ at: "2026-11-25T01:08:00.000Z", action: `${EDIT_ACTION_PREFIX}: One capsule at night.`, ref: scenario.listing.id }),
        ],
      }),
    );
    expect(view.entries.map((e) => e.action)).toEqual([EDIT_ACTION_PREFIX, EDIT_ACTION_PREFIX]);
    expect(view.entries[0].change).toMatchObject({ before: scenario.listing.description, after: "One capsule a day." });
    expect(view.entries[1].change).toMatchObject({ before: "One capsule a day.", after: "One capsule at night." });
    expect(view.entries[0]).toMatchObject({ kind: "human", humanKind: "edit", humanLabel: "Human edit" });
  });

  it("counts approvals by their APR ref, so edits, sends, send-backs and rejections are human rows but not approvals", () => {
    const rows: DemoAuditRow[] = [
      row({ action: "Approved sourcing", ref: first.approvalId }),
      row({ action: `${EDIT_ACTION_PREFIX}: new wording`, ref: scenario.listing.id }),
      row({ action: SEND_ACTION, ref: scenario.listing.id }),
      row({ action: `${SEND_BACK_ACTION_PREFIX}: x`, ref: scenario.listing.id }),
      row({ action: `${REJECT_ACTION_PREFIX}: x`, ref: scenario.gap.id }),
      row({ action: "Approved listing and promo", ref: second.approvalId }),
    ];
    const view = auditView(scenario, fixtureState({ audit: rows }));
    expect(view.approvals).toEqual({ count: 2, refs: [first.approvalId, second.approvalId], label: "2 human approvals" });
    expect(view.otherHuman).toEqual({ count: 4, label: "4 other human actions · not approvals" });
    expect(view.entries.map((e) => e.humanKind)).toEqual(["approval", "edit", "send", "send_back", "reject", "approval"]);
    expect(view.entries.map((e) => e.humanLabel)).toEqual(["Approval 1 of 2", "Human edit", "Human send", "Human send-back", "Human rejection", "Approval 2 of 2"]);
  });

  it("does not count a look-alike: an agent row, a bare prefix, a non-numeric ref or a repeat of the same approval", () => {
    const prefixOnly = approvalRef({ actorKind: "human", ref: first.approvalId.replace(/\d+$/, "") });
    expect(prefixOnly).toBeNull();
    expect(approvalRef({ actorKind: "human", ref: `${first.approvalId}x` })).toBeNull();
    expect(approvalRef({ actorKind: "human", ref: null })).toBeNull();
    expect(approvalRef({ actorKind: "agent", ref: first.approvalId })).toBeNull();
    expect(approvalRef({ actorKind: "system", ref: first.approvalId })).toBeNull();
    expect(approvalRef({ actorKind: "human", ref: first.approvalId })).toBe(first.approvalId);

    const rows = [
      row({ actorKind: "agent", actor: "Shelf Agent", ref: first.approvalId }),
      row({ ref: first.approvalId }),
      row({ ref: first.approvalId }),
      row({ ref: scenario.listing.id }),
    ];
    expect(approvalRefs(rows)).toEqual([first.approvalId]);
    const view = auditView(scenario, fixtureState({ audit: rows }));
    expect(view.approvals.count).toBe(1);
    expect(view.approvals.label).toBe("1 human approval");
    expect(view.agent.count).toBe(1);
  });

  it("counts the agent steps from the agent rows and says nothing about other human actions when there are none", () => {
    const view = auditView(scenario, fixtureState());
    expect(view.agent).toEqual({ count: scenario.timing.agentSteps, label: `${scenario.timing.agentSteps} agent steps` });
    expect(view.approvals.count).toBe(scenario.timing.humanApprovals);
    expect(view.approvals.refs).toEqual([first.approvalId, second.approvalId]);
    expect(view.otherHuman).toBeNull();
  });

  it("shows the fixture's detection-to-live time only once approval 2 has published", () => {
    const live = auditView(scenario, fixtureState({ listed: true, approvals: { sourcing: approvalOf(first.id, first.approvalId), launch: approvalOf(second.id, second.approvalId) } }));
    expect(live.elapsed).toEqual({ pill: `${scenario.timing.totalLabel}, gap to live`, detail: "Live in about 7 minutes" });
    expect(live.elapsed?.pill).toContain(scenario.timing.totalLabel);

    const waiting = auditView(scenario, fixtureState({ listed: false, approvals: { sourcing: approvalOf(first.id, first.approvalId) } }));
    expect(waiting.elapsed).toBeNull();
    const approvedOnly = auditView(scenario, fixtureState({ listed: false, approvals: { launch: approvalOf(second.id, second.approvalId) } }));
    expect(approvedOnly.elapsed).toBeNull();
  });

  it("keeps step 7 as the screen being read, and marks earlier steps done only when they are", () => {
    const live = auditView(scenario, fixtureState({ listed: true, approvals: { sourcing: approvalOf(first.id, first.approvalId), launch: approvalOf(second.id, second.approvalId) } }));
    expect(live.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "done", "current"]);

    const fresh = auditView(scenario, { stage: 0, approvals: {}, audit: [], listed: false });
    expect(fresh.steps.map((s) => s.state)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming", "upcoming", "upcoming", "current"]);
  });

  it("tolerates rows with missing or odd fields, and gives an unknown actor kind no agent or human styling", () => {
    const odd = { at: "2026-11-25T01:10:00.000Z", action: "Something", actorKind: "robot", actor: 7, source: null, ref: 5 } as unknown as DemoAuditRow;
    const view = auditView(scenario, fixtureState({ audit: [odd] }));
    expect(view.entries[0]).toMatchObject({ kind: "system", actor: "—", source: "—", ref: null, humanKind: null });
    expect(view.agent.count).toBe(0);
    expect(view.approvals.count).toBe(0);
  });

  it("says so when the store cannot be read, rather than showing an empty trail", () => {
    const view = auditView(scenario, null);
    expect(view.unavailable).toBe(true);
    const html = renderTimeline(view);
    expect(html).toContain("data-audit-unavailable");
    expect(html).not.toContain("data-audit-empty");
  });
});

describe("the audit timeline screen", () => {
  it("renders the title, pills, columns and every row, with the DEMO DATA tag and the SPEC footer", () => {
    const state = fixtureState({ listed: true, approvals: { sourcing: approvalOf(first.id, first.approvalId), launch: approvalOf(second.id, second.approvalId) } });
    const html = renderTimeline(auditView(scenario, state));
    expect(html).toContain("Audit trail · Magnesium Glycinate");
    expect(html).toMatch(/<span data-demo-tag="[^"]*"[^>]*>DEMO DATA<\/span>/);
    expect(html).toContain(`${scenario.timing.totalLabel}, gap to live`);
    expect(html).toContain("6 agent steps");
    expect(html).toContain("2 human approvals");
    expect(html).toContain(`${first.approvalId}, ${second.approvalId}`);
    for (const label of ["Time (SGT)", "Actor", "Action", "Data source", "ID"]) expect(html).toContain(label);
    expect(html.match(/data-audit-row/g)).toHaveLength(scenario.audit.length);
    expect(html).toContain("09:09:21");
    expect(html).toContain(AUDIT_FOOTER);
    expect(html).toContain('href="/demo/pelita/ops"');
    expect(html).toContain('href="/demo/pelita"');
  });

  it("shows the removed claim as Before and After, in words and not only in colour", () => {
    const html = renderTimeline(auditView(scenario, fixtureState()));
    const change = /data-audit-change[^>]*>(.*?<\/div>.*?<\/div>)/.exec(html)?.[1] ?? "";
    expect(change).toContain("Before:");
    expect(change).toContain("After:");
    expect(change).toContain(`<del class="text-danger">${scenario.claimsCheck.removed[0].claim}</del>`);
    expect(change).toContain(scenario.claimsCheck.kept[0]);
    expect(html.match(/data-audit-change/g)).toHaveLength(1);
  });

  it("uses violet for agent rows and navy for approval rows only: an edit or send row is a person in plain ink", () => {
    const rows = [
      row({ actorKind: "agent", actor: "Shelf Agent", action: "Agent step", ref: null }),
      row({ action: "Approved", ref: first.approvalId }),
      row({ action: `${EDIT_ACTION_PREFIX}: new wording`, ref: scenario.listing.id }),
      row({ action: SEND_ACTION, ref: scenario.listing.id }),
      row({ actorKind: "system", actor: "Storefront", action: "Published", ref: "LIVE" }),
    ];
    const html = renderTimeline(auditView(scenario, fixtureState({ audit: rows })));
    const rowHtml = (kind: string) => [...html.matchAll(new RegExp(`<tr data-audit-row[^>]*data-human-kind="${kind}"[^>]*>.*?</tr>`, "g"))].map((m) => m[0]);
    const [agent] = [...html.matchAll(/<tr data-audit-row[^>]*data-actor-kind="agent"[^>]*>.*?<\/tr>/g)].map((m) => m[0]);
    const [system] = [...html.matchAll(/<tr data-audit-row[^>]*data-actor-kind="system"[^>]*>.*?<\/tr>/g)].map((m) => m[0]);
    expect(agent).toContain("text-agent");
    expect(agent).not.toMatch(/(text|bg|border)-human/);
    expect(system).not.toMatch(/(text|bg|border)-(agent|human)/);
    const [approval] = rowHtml("approval");
    expect(approval).toContain("bg-human-50");
    expect(approval).toContain("text-human");
    expect(approval).not.toMatch(/(text|bg|border)-agent/);
    for (const kind of ["edit", "send"]) {
      const [other] = rowHtml(kind);
      expect(other, kind).toBeDefined();
      expect(other, kind).not.toMatch(/(text|bg|border)-(human|agent)/);
    }
    expect(html).toContain("1 human approval");
    expect(html).toContain("2 other human actions · not approvals");
  });

  it("shows an empty notice, and Not live yet, before anything is logged", () => {
    const html = renderTimeline(auditView(scenario, { stage: 0, approvals: {}, audit: [], listed: false }));
    expect(html).toContain("data-audit-empty");
    expect(html).toContain("Not live yet");
    expect(html).not.toContain("gap to live");
    expect(html).toContain("0 agent steps");
    expect(html).toContain("0 human approvals");
  });

  it("is linked from the ops console rail and from both published states", () => {
    const view = opsConsoleView(scenario, { approvals: {}, audit: [] });
    const ops = renderToStaticMarkup(createElement(PelitaOpsConsole, { view }));
    expect(ops).toMatch(/<a [^>]*href="\/demo\/pelita\/audit"[^>]*>Audit<\/a>/);

    const state = fixtureState({ listed: true, approvals: { sourcing: approvalOf(first.id, first.approvalId), launch: approvalOf(second.id, second.approvalId) } });
    const published = publishedView(scenario, state);
    expect(published).not.toBeNull();
    const storefront = renderToStaticMarkup(createElement(PelitaStorefront, { view: storefrontView(scenario, { listed: true, published }) }));
    expect(storefront).toMatch(/data-live-toast[\s\S]*href="\/demo\/pelita\/audit"[^>]*>View the audit trail →<\/a>/);

    const panel = renderToStaticMarkup(
      createElement(PelitaLaunchApproval, {
        data: approvalView(scenario, state).launch,
        phase: "launched",
        actor: approvalView(scenario, state).approvers[1],
        sourcing: null,
        launch: null,
        sentBack: null,
        published,
        busy: false,
        error: null,
        onApprove: () => undefined,
        onSendBack: () => undefined,
      }),
    );
    expect(panel).toMatch(/data-launch-published[\s\S]*href="\/demo\/pelita\/audit"[^>]*>View the audit trail →<\/a>/);
  });
});

describe("the audit timeline against the real launch flow", () => {
  beforeEach(useFakeRedis);

  async function renderPage(): Promise<string> {
    const Page = (await import("@/app/demo/pelita/audit/page")).default;
    return renderToStaticMarkup(await Page());
  }

  it("reads a full run: two approvals by APR ref, the edit and send as human rows that are not approvals, then live", async () => {
    openGate();
    await toLaunched();
    sent = [];
    const html = await renderPage();
    expect(sent.filter(([name]) => name !== "GET" && name !== "LRANGE")).toEqual([]);

    const state = await getDemoState();
    const view = auditView(scenario, state);
    expect(view.approvals).toMatchObject({ count: 2, refs: [first.approvalId, second.approvalId] });
    expect(view.otherHuman?.count).toBe(2);
    expect(view.agent.count).toBe(4);
    expect(view.entries.map((e) => e.kind)).toEqual(state.audit.map((r) => r.actorKind));
    expect(view.entries.at(-1)).toMatchObject({ kind: "system", ref: "LIVE" });
    expect(view.entries.some((e) => e.change?.before === scenario.claimsCheck.removed[0].claim)).toBe(true);
    expect(view.entries.find((e) => e.humanKind === "edit")?.change).toMatchObject({ before: scenario.listing.description, after: "Gentle magnesium. Supports restful sleep. Vegan." });
    expect(view.elapsed?.pill).toBe(`${scenario.timing.totalLabel}, gap to live`);

    expect(html).toContain("2 human approvals");
    expect(html).toContain("2 other human actions · not approvals");
    expect(html).toContain("4 agent steps");
    expect(html).toContain("09:03:35");
    expect(html).toContain("09:09:05");
    expect(html).toContain(`${scenario.timing.totalLabel}, gap to live`);
  });

  it("does not count a send-back as an approval", async () => {
    openGate();
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
    await continueFromStockCheck(scenario);
    await runListingDraft(scenario, { ...defaultListingDeps, wait: instant, now: () => T_DRAFT });
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toMatchObject({ ok: true, changed: true });
    const view = auditView(scenario, await getDemoState());
    expect(view.approvals.count).toBe(1);
    expect(view.otherHuman?.count).toBe(2);
    expect(view.entries.at(-1)).toMatchObject({ humanKind: "send_back" });
    expect(view.elapsed).toBeNull();
  });

  it("shows a rejection as a human row that is not an approval", async () => {
    openGate();
    await rejectProposal(scenario, T1);
    const view = auditView(scenario, await getDemoState());
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ humanKind: "reject", ref: scenario.gap.id });
    expect(view.approvals.count).toBe(0);
    expect(view.otherHuman?.count).toBe(1);
  });

  it("shows an unavailable notice when the store is down", async () => {
    openGate();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await renderPage()).toContain("data-audit-unavailable");
  });
});

describe("reset clears the audit timeline, and the timeline adds no state key", () => {
  beforeEach(useFakeRedis);

  it("keeps the fixed key list: the four state keys plus the write guards", () => {
    expect([...STATE_KEY_NAMES]).toEqual(["stage", "approvals", "audit", "listed", "claim:sourcing", "claim:launch", "opening", "elapsed", "epoch"]);
    expect(STATE_KEYS).toEqual(STATE_KEY_NAMES.map((name) => `kb:demo:pelita:${name}`));
  });

  it("writes only keys on the fixed list during a full run, and reading the timeline writes nothing", async () => {
    openGate();
    await toLaunched();
    const Page = (await import("@/app/demo/pelita/audit/page")).default;
    sent = [];
    renderToStaticMarkup(await Page());
    expect(sent.every(([name]) => name === "GET" || name === "LRANGE")).toBe(true);
    const pelitaKeys = [...store.keys()].filter((k) => k.startsWith("kb:demo:pelita:") && !(k in FOREIGN));
    expect(pelitaKeys.sort()).toEqual(STATE_KEYS.filter((k) => !["opening", "elapsed", "epoch"].some((name) => k === `kb:demo:pelita:${name}`)).sort());
  });

  it("empties the timeline after reset, drops the elapsed time and the counts, and leaves foreign keys alone", async () => {
    openGate();
    await toLaunched();
    const Page = (await import("@/app/demo/pelita/audit/page")).default;
    expect(renderToStaticMarkup(await Page())).toContain("gap to live");
    expect(auditView(scenario, await getDemoState()).entries.length).toBeGreaterThan(0);

    const headers = new Headers({ origin: "https://x.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` });
    const res = await resetRoute(new Request("https://x.test/api/demo/pelita/reset", { method: "POST", headers }));
    expect(res.status).toBe(200);

    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    const view = auditView(scenario, await getDemoState());
    expect(view.entries).toEqual([]);
    expect(view.approvals).toEqual({ count: 0, refs: [], label: "0 human approvals" });
    expect(view.agent.count).toBe(0);
    expect(view.otherHuman).toBeNull();
    expect(view.elapsed).toBeNull();

    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("data-audit-empty");
    expect(html).not.toContain("gap to live");
    expect(html).not.toContain("data-audit-row");
    for (const [k, v] of Object.entries(FOREIGN)) expect(store.get(k)).toBe(v);
    const pelitaKeys = [...store.keys()].filter((k) => k.startsWith("kb:demo:pelita:") && !(k in FOREIGN));
    expect(pelitaKeys.sort()).toEqual(["kb:demo:pelita:epoch", "kb:demo:pelita:listed", "kb:demo:pelita:stage"]);
  });

  it("still serves the audit rows through the existing gated state route, and a second reset is harmless", async () => {
    openGate();
    await toLaunched();
    const headers = { cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` };
    const res = await readState(new Request("https://x.test/api/demo/pelita/state", { headers }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { audit: unknown[] }).audit.length).toBeGreaterThan(0);
    const resetHeaders = { ...headers, origin: "https://x.test" };
    for (let i = 0; i < 2; i++) {
      expect((await resetRoute(new Request("https://x.test/api/demo/pelita/reset", { method: "POST", headers: resetHeaders }))).status).toBe(200);
    }
    expect((await getDemoState()).audit).toEqual([]);
  });
});

describe("/demo/pelita/audit gate", () => {
  async function loadPage() {
    return (await import("@/app/demo/pelita/audit/page")).default;
  }
  const notFound = { digest: expect.stringContaining("404") };

  beforeEach(useFakeRedis);

  it("is a 404 when the track flag is off, even with a valid cookie", async () => {
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    await expect((await loadPage())()).rejects.toMatchObject(notFound);
  });

  it("is a 404 on production until the flag is set, then renders with no cookie", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    await expect((await loadPage())()).rejects.toMatchObject(notFound);

    openGate();
    process.env.VERCEL_ENV = "production";
    cookieJar.value = undefined;
    const html = renderToStaticMarkup(await (await loadPage())());
    expect(html).toContain("Audit trail · Magnesium Glycinate");
  });

  it("is a 404 without a secret, and renders with no cookie or a forged cookie once the gate is open", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    cookieJar.value = signPresenterToken(SECRET);
    await expect((await loadPage())()).rejects.toMatchObject(notFound);

    process.env.APPROVAL_SECRET = SECRET;
    const Page = await loadPage();
    cookieJar.value = undefined;
    expect(renderToStaticMarkup(await Page())).toContain("Audit trail · Magnesium Glycinate");
    cookieJar.value = `${signPresenterToken(SECRET)}0`;
    expect(renderToStaticMarkup(await Page())).toContain("Audit trail · Magnesium Glycinate");
    cookieJar.value = signPresenterToken(SECRET, Date.now() - 2 * 60 * 60 * 1000, 60 * 1000);
    expect(renderToStaticMarkup(await Page())).toContain("Audit trail · Magnesium Glycinate");
  });

  it("never reads the store before the gate has said yes", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    await expect((await loadPage())()).rejects.toMatchObject(notFound);
    expect(sent).toEqual([]);

    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = undefined;
    expect(renderToStaticMarkup(await (await loadPage())())).toContain("Audit trail · Magnesium Glycinate");
    expect(sent.length).toBeGreaterThan(0);
  });

  it("renders with no presenter cookie, and the proxy gate covers the public paths", async () => {
    openGate();
    cookieJar.value = undefined;
    const html = renderToStaticMarkup(await (await loadPage())());
    expect(html).toContain("Audit trail · Magnesium Glycinate");
    expect(pelitaPageAllowed("/demo/pelita/audit")).toBe(true);
    expect(pelitaPageAllowed("/pelita")).toBe(true);
    expect(pelitaPageAllowed("/pelita/audit")).toBe(true);
    delete process.env.KB_DEMO_TRACK;
    expect(pelitaPageAllowed("/demo/pelita/audit")).toBe(false);
    expect(pelitaPageAllowed("/pelita")).toBe(false);
  });

  it("adds no API of its own: the page keeps requirePresenterPage and the browser makes no request", () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    expect(read("src/app/demo/pelita/audit/page.tsx")).toMatch(/await requirePresenterPage\(\)/);
    const requirePos = read("src/app/demo/pelita/audit/page.tsx").indexOf("await requirePresenterPage()");
    expect(requirePos).toBeGreaterThan(-1);
    expect(requirePos).toBeLessThan(read("src/app/demo/pelita/audit/page.tsx").indexOf("getDemoSnapshot()"));
    expect(read("src/components/pelita-ops/PelitaAuditTimeline.tsx")).not.toMatch(/fetch\(|"use client"/);
    const routes = readFileSync(path.join(ROOT, "src/app/api/demo/pelita/state/route.ts"), "utf8");
    expect(routes).toMatch(/guardDemoApi\(req\)/);
  });
});

describe("audit timeline code holds no fixture figures, and touches no database, identity or env", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("has no hardcoded names, ids, amounts, claim wording or timing", () => {
    const fixtureValues = [
      ...scenario.approvers.flatMap((a) => [a.name, a.id, a.approvalId, a.role]),
      scenario.listing.id,
      scenario.listing.title,
      scenario.listing.description,
      scenario.claimsCheck.id,
      scenario.purchaseOrder.id,
      scenario.gap.id,
      scenario.promo.ribbon,
      scenario.timing.totalLabel,
      scenario.proposal.supplier,
      ...scenario.claimsCheck.removed.flatMap((r) => [r.claim, r.reason]),
      ...scenario.claimsCheck.kept,
      ...scenario.audit.flatMap((r) => [r.action, r.actor, r.source]).filter((value) => value.length >= 12),
    ];
    const figures = [scenario.timing.totalSeconds, scenario.sourcing.spendLimit, scenario.gap.searches, scenario.listing.onlineStock, scenario.proposal.price];
    for (const file of AUDIT_FILES) {
      const text = read(file);
      for (const value of fixtureValues) expect(text, `${file}: ${value}`).not.toContain(value);
      for (const figure of figures) expect(text, `${file}: ${figure}`).not.toMatch(new RegExp(`(?<![\\w.-])${String(figure).replace(/\./g, "\\.")}(?![\\w.])`));
      expect(text, file).not.toMatch(/APR-\d|PO-\d|CMP-\d|LST-\d|PRP-\d|S\$\d|cures insomnia|Priya|Daniel|Mei Ling|Arjun|Evergreen|Tuas|7 min|11 s/);
    }
  });

  it("makes no identity-provider, database or env access, and imports only demo modules for its logic", () => {
    for (const file of AUDIT_FILES) {
      expect(read(file), file).not.toMatch(/auth0|management|@neondatabase|bi-db|bi-events|process\.env|redisPipeline|from "\.\.?\/(\.\.\/)?upstash"|\bfetch\(/i);
    }
    for (const file of ["src/lib/demo/audit-view.ts", "src/lib/demo/audit-links.ts"]) {
      for (const match of read(file).matchAll(/^import .* from "([^"]+)";$/gm)) expect(match[1], file).toMatch(/^\.\//);
    }
  });

  it("uses the colour tokens: violet only for the agent, navy only for approvals", () => {
    const view = read("src/lib/demo/audit-view.ts");
    expect(view).not.toMatch(/#5B3FD1|#1E3A8A/i);
    const component = read("src/components/pelita-ops/PelitaAuditTimeline.tsx");
    expect(component).not.toMatch(/#5B3FD1|#1E3A8A/i);
    expect(scenario.brand.palette).toMatchObject({ agent: "#5B3FD1", human: "#1E3A8A" });
  });
});
