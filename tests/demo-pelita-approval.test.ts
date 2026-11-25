import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "@/data/demo-scenario.json";
import { POST as approvalRoute } from "@/app/api/demo/pelita/approval/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaApprovalModal } from "@/components/pelita-ops/PelitaApprovalModal";
import { PelitaLaunchApproval } from "@/components/pelita-ops/PelitaLaunchApproval";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { approveLaunch, approveSourcing, sendBackLaunch } from "@/lib/demo/approval";
import {
  approvalView,
  launchPhase,
  launchRail,
  sgdLabel,
  type ApprovalView,
  type LaunchPhase,
} from "@/lib/demo/approval-view";
import { defaultListingDeps, runListingDraft, sendForApproval } from "@/lib/demo/listing";
import { opsConsoleView, type OpsConsoleView } from "@/lib/demo/ops-console";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";
import { STATE_KEYS, STATE_KEY_NAMES, getDemoState, resetDemo } from "@/lib/demo/state";
import { continueFromStockCheck, defaultStockCheckDeps, runStockCheck } from "@/lib/demo/stock-check";
import { CHECK_ACTION } from "@/lib/demo/stock-check-view";

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
const URL = "https://x.test/api/demo/pelita/approval";
const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};
const NEW_FILES = [
  "src/lib/demo/approval.ts",
  "src/lib/demo/approval-view.ts",
  "src/lib/demo/approval-client.ts",
  "src/components/pelita-ops/PelitaApprovalModal.tsx",
  "src/components/pelita-ops/PelitaLaunchApproval.tsx",
  "src/app/api/demo/pelita/approval/route.ts",
  "src/lib/demo/listing.ts",
  "src/lib/demo/listing-view.ts",
  "src/lib/demo/listing-client.ts",
  "src/lib/demo/published-view.ts",
  "src/components/pelita-ops/PelitaListingDraft.tsx",
  "src/app/api/demo/pelita/listing/route.ts",
];

let store: Map<string, string | string[]>;
let sent: Command[];

function fakeRedis(commands: Command[]): unknown[] {
  return commands.map((command) => {
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

function post(url: string, body: unknown, opts: { cookie?: boolean; origin?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json", origin: opts.origin ?? "https://x.test" });
  if (opts.cookie !== false) headers.set("cookie", `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}`);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function editedScenario(edit: (draft: typeof raw) => void) {
  const draft = structuredClone(raw);
  edit(draft);
  return parseScenario(draft);
}

const scenario = loadScenario();
const [first, second] = [...scenario.approvers].sort((a, b) => a.slot - b.slot);
const T1 = new Date("2026-11-25T01:03:35.000Z");
const T2 = new Date("2026-11-25T01:09:05.000Z");
const phaseOf = async () => launchPhase(scenario, await getDemoState());
const T_SEND = new Date("2026-11-25T01:06:50.000Z");
const instant = async () => undefined;

/**
 * Approval 2 opens only once the agent has checked stock, drafted the listing and a person has
 * sent that draft for approval, so the tests that approve or send back first walk that path
 * through the real code with instant delays.
 */
async function reachApproval2(): Promise<void> {
  await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
  await continueFromStockCheck(scenario);
  await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
  await sendForApproval(scenario, { approverId: first.id }, T_SEND);
}

/** The agent's own fixture rows: the stock check, the purchase order, the claims check and the listing draft. */
const agentRows = scenario.audit.filter((row) => row.actorKind === "agent");

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

describe("two-person approval state transitions", () => {
  beforeEach(useFakeRedis);

  it("starts at sourcing_pending with nothing approved", async () => {
    expect(await phaseOf()).toBe("sourcing_pending");
    expect((await getDemoState()).approvals).toEqual({});
  });

  it("approval 1: records the sourcing approval and one human audit row, then hands over to the stock check", async () => {
    const result = await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      phase: "stock_check",
      published: null,
      approval: { by: first.name, approverId: first.id, approvalId: scenario.sourcing.approvalId, atLabel: "09:03" },
    });
    const state = await getDemoState();
    expect(state.approvals.sourcing).toEqual({ approvalId: scenario.sourcing.approvalId, approverId: first.id, at: T1.toISOString() });
    expect(state.approvals.launch).toBeUndefined();
    expect(state.audit).toEqual([
      {
        at: T1.toISOString(),
        actorKind: "human",
        actor: `${first.name} · ${first.role}`,
        action: `Approved sourcing, spend limit ${sgdLabel(scenario.sourcing.spendLimit)}`,
        source: "Ops console",
        ref: scenario.sourcing.approvalId,
      },
    ]);
    expect(await phaseOf()).toBe("stock_check");
  });

  it("approval 2: a different person approves the listing and promo, with a second audit row", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await reachApproval2();
    const result = await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      phase: "launched",
      approval: { by: second.name, approvalId: scenario.launchApproval.approvalId, atLabel: "09:09" },
    });
    const state = await getDemoState();
    expect(state.approvals.launch).toEqual({ approvalId: scenario.launchApproval.approvalId, approverId: second.id, at: T2.toISOString() });
    expect(state.approvals.sourcing?.approverId).not.toBe(state.approvals.launch?.approverId);
    expect(state.audit.map((row) => row.ref).filter((ref) => ref?.startsWith("APR-"))).toEqual([
      scenario.sourcing.approvalId,
      scenario.launchApproval.approvalId,
    ]);
    expect(state.audit.find((row) => row.ref === scenario.launchApproval.approvalId)).toMatchObject({
      actorKind: "human",
      actor: `${second.name} · ${second.role}`,
      action: "Approved listing and promo",
    });
    expect(await phaseOf()).toBe("launched");
  });

  it("refuses the same person approving twice, and approver 2 being approver 1, writing nothing", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    const before = structuredClone(await getDemoState());

    expect(await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "already_approved" });
    expect(await approveLaunch(scenario, { approverId: first.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "same_person" });
    expect(await sendBackLaunch(scenario, { approverId: first.id }, T2)).toEqual({ ok: false, reason: "same_person" });

    expect(await getDemoState()).toEqual(before);
    expect(await phaseOf()).toBe("stock_check");
  });

  it("refuses a second approval from the launch approver after the launch is approved", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await reachApproval2();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    const before = structuredClone(await getDemoState());
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "already_approved" });
    expect(await approveLaunch(scenario, { approverId: first.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "same_person" });
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toEqual({ ok: false, reason: "already_approved" });
    expect(await getDemoState()).toEqual(before);
  });

  it("refuses an approver who does not own the step, an unknown person and an unticked confirmation", async () => {
    expect(await approveSourcing(scenario, { approverId: second.id, confirmed: true }, T1)).toEqual({ ok: false, reason: "wrong_approver" });
    expect(await approveSourcing(scenario, { approverId: "someone-else", confirmed: true }, T1)).toEqual({ ok: false, reason: "unknown_approver" });
    expect(await approveSourcing(scenario, { approverId: first.id, confirmed: false }, T1)).toEqual({ ok: false, reason: "confirmation_required" });
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T1)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T1)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });

    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await reachApproval2();
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: false }, T2)).toEqual({ ok: false, reason: "confirmation_required" });
    expect((await getDemoState()).approvals.launch).toBeUndefined();
  });

  it("reject (screen 01): logs one audit row, blocks both approvals, and is refused once sourcing is approved", async () => {
    expect(await rejectProposal(scenario, T1)).toMatchObject({ ok: true, changed: true, status: "rejected" });
    expect(await phaseOf()).toBe("rejected");
    expect(await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "proposal_rejected" });
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "sourcing_required" });
    const state = await getDemoState();
    expect(state.audit).toHaveLength(1);
    expect(state.approvals).toEqual({});

    await resetDemo();
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    expect(await rejectProposal(scenario, T2)).toEqual({ ok: false, status: "approved" });
  });

  it("send back (screen 05): one audit row, blocks approval 2, and repeats as a no-op", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await reachApproval2();
    const rowsBefore = (await getDemoState()).audit.length;
    const result = await sendBackLaunch(scenario, { approverId: second.id }, T2);
    expect(result).toEqual({ ok: true, changed: true, phase: "sent_back", sentBack: { by: second.name, atLabel: "09:09" } });
    const state = await getDemoState();
    expect(state.audit).toHaveLength(rowsBefore + 1);
    expect(state.audit[rowsBefore]).toMatchObject({
      actorKind: "human",
      actor: `${second.name} · ${second.role}`,
      action: `Sent back listing and promo: ${scenario.listing.title}`,
      ref: scenario.listing.id,
    });
    expect(launchPhase(scenario, state)).toBe("sent_back");
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "sent_back" });
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toMatchObject({ ok: true, changed: false });
    expect((await getDemoState()).audit).toHaveLength(rowsBefore + 1);
  });

  it("reset clears approvals, audit and send back, leaves foreign keys alone, and the flow can run again", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    await reachApproval2();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    expect(await phaseOf()).toBe("launched");

    expect(await resetDemo()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(await phaseOf()).toBe("sourcing_pending");
    expect(store.get("kb:demo:pelita:approvals")).toBeUndefined();
    expect(store.get("kb:demo:pelita:audit")).toBeUndefined();
    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);

    expect(await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1)).toMatchObject({ ok: true, changed: true });
    await reachApproval2();
    await sendBackLaunch(scenario, { approverId: second.id }, T2);
    await resetDemo();
    expect(await phaseOf()).toBe("sourcing_pending");
    expect((await getDemoState()).audit).toEqual([]);
  });

  it("writes an approval and its audit row in one request, only to keys on the fixed list", async () => {
    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    const writes = sent.filter((command) => command[0] === "SET" || command[0] === "RPUSH");
    expect(writes.map((command) => [command[0], String(command[1]).replace("kb:demo:pelita:", "")])).toEqual([
      ["SET", "claim:sourcing"],
      ["SET", "approvals"],
      ["RPUSH", "audit"],
    ]);
    await reachApproval2();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    await sendBackLaunch(scenario, { approverId: second.id }, T2);
    await resetDemo();
    expect(sent.length).toBeGreaterThan(0);
    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(String(target).startsWith("kb:demo:pelita:")).toBe(true);
      expect(STATE_KEYS).toContain(target);
    }
    expect(STATE_KEY_NAMES).toEqual(["stage", "approvals", "audit", "listed", "claim:sourcing", "claim:launch", "opening"]);
  });
});

describe("approval phases and rail", () => {
  it("derives the phase from approvals and audit rows only", () => {
    const base = { approvals: {}, audit: [] };
    const sourcing = { approvalId: "x", approverId: first.id, at: T1.toISOString() };
    const row = (ref: string, action: string) => ({ at: T1.toISOString(), actorKind: "human" as const, actor: "A", action, source: "Ops console", ref });
    expect(launchPhase(scenario, base)).toBe("sourcing_pending");
    expect(launchPhase(scenario, { ...base, audit: [row(scenario.gap.id, "Rejected proposal: x")] })).toBe("rejected");
    expect(launchPhase(scenario, { approvals: { sourcing }, audit: [] })).toBe("stock_check");
    expect(launchPhase(scenario, { approvals: { sourcing }, audit: [row(scenario.listing.id, "Sent back listing and promo: x")] })).toBe("sent_back");
    expect(launchPhase(scenario, { approvals: { sourcing, launch: sourcing }, audit: [] })).toBe("launched");
  });

  it("opens screen 05 only for a real listing draft that was sent for approval", () => {
    const sourcing = { approvalId: "x", approverId: first.id, at: T1.toISOString() };
    const stockRows = agentRows.filter((r) => r.ref === scenario.purchaseOrder.id || r.action === CHECK_ACTION);
    const draftRows = agentRows.filter((r) => r.ref === scenario.claimsCheck.id || r.ref === scenario.listing.id);
    const at = (stage: number, audit: typeof agentRows) => launchPhase(scenario, { stage, approvals: { sourcing }, audit });
    expect(stockRows).toHaveLength(2);
    expect(draftRows).toHaveLength(2);
    expect(at(3, stockRows)).toBe("stock_check");
    expect(at(4, [])).toBe("stock_check");
    expect(at(4, stockRows)).toBe("listing_draft");
    expect(at(4, [...stockRows, draftRows[0]])).toBe("listing_draft");
    expect(at(5, stockRows)).toBe("listing_draft");
    expect(at(4, [...stockRows, ...draftRows])).toBe("listing_draft");
    expect(at(5, [...stockRows, ...draftRows])).toBe("launch_pending");
    expect(at(5, draftRows)).toBe("stock_check");
  });

  it("outlines step 2 under the modal, step 5 for the launch approval and Live once approved", () => {
    const current = (phase: LaunchPhase, modal = false) => launchRail(phase, modal).find((s) => s.state === "current");
    expect(current("sourcing_pending")).toMatchObject({ n: 1, kind: "agent" });
    expect(current("sourcing_pending", true)).toMatchObject({ n: 2, label: "Approve sourcing", kind: "human" });
    expect(current("launch_pending")).toMatchObject({ n: 5, label: "Approve launch", kind: "human" });
    expect(current("listing_draft")).toMatchObject({ n: 4, label: "Draft listing", kind: "agent" });
    expect(current("sent_back")).toMatchObject({ n: 5 });
    expect(current("launched")).toMatchObject({ n: 6, label: "Live" });
    expect(launchRail("launch_pending").filter((s) => s.state === "done")).toHaveLength(4);
  });
});

describe("approval view (screens 02 and 05)", () => {
  const view = approvalView(scenario, { approvals: {}, audit: [] });

  it("takes both approvers, ids and every figure from the fixture", () => {
    expect(view.approvers.map((a) => a.name)).toEqual([first.name, second.name]);
    expect(view.defaultActorId).toBe(first.id);
    expect(view.sourcing.chip).toBe(`Records as ${scenario.sourcing.approvalId}`);
    expect(view.sourcing.summary.map((r) => r.label)).toEqual(["Product", "Supplier", "First order", "Spend limit"]);
    expect(view.sourcing.summary[1].value).toBe(scenario.proposal.supplier);
    expect(view.sourcing.summary[2].value).toBe(`Up to ${scenario.sourcing.maxUnits} units (about ${scenario.sourcing.approxWeeks} weeks)`);
    expect(view.sourcing.summary[3].value).toBe(sgdLabel(scenario.sourcing.spendLimit));
    expect(view.sourcing.checkboxLabel).toBe(scenario.sourcing.checkboxLabel);
    expect(view.sourcing.waitingLabel).toBe(`Waiting for ${first.role} approval`);

    expect(view.launch.chip).toBe(`Records as ${scenario.launchApproval.approvalId}`);
    expect(view.launch.checkboxLabel).toBe(scenario.launchApproval.checkboxLabel);
    expect(view.launch.approver.id).toBe(second.id);
    expect(view.launch.stats).toEqual([
      { value: `${scenario.promo.marginPct}%`, label: `margin at promo, above ${scenario.promo.marginFloorPct}% floor` },
      { value: sgdLabel(scenario.promo.projectedWeek1Sales), label: "projected sales, week 1" },
    ]);
  });

  it("shows the 2-for promo with the claim already removed", () => {
    const rows = Object.fromEntries(view.launch.diff.map((r) => [r.label, r.value]));
    expect(rows["Launch promo"]).toBe(`${scenario.promo.ribbon} · 25 Nov – 8 Dec`);
    expect(rows["Launch promo"]).toContain("2 for S$55.90");
    expect(rows["Price"]).toBe("S$32.90");
    expect(rows["Online stock"]).toBe(`${scenario.listing.onlineStock} units from Tuas DC`);
    expect(rows["Claims check"]).toBe(`Passed · ${scenario.claimsCheck.id}`);
    expect(scenario.listing.description).not.toMatch(/insomnia/i);
    expect(JSON.stringify(view)).not.toMatch(/insomnia/i);
    expect(scenario.claimsCheck.removed.map((r) => r.claim)).toEqual(["cures insomnia"]);
  });

  it("follows fixture edits and starts approval 2 with approver 2", () => {
    const edited = approvalView(
      editedScenario((draft) => {
        draft.sourcing.spendLimit = 12_000;
        draft.purchaseOrder.total = 11_100;
        draft.promo.bundlePrice = 54.9;
        draft.promo.ribbon = "2 for S$54.90";
        draft.promo.marginPct = 10;
        draft.approvers[1].name = "Someone Else";
      }),
      {
        stage: 5,
        approvals: { sourcing: { approvalId: "x", approverId: first.id, at: T1.toISOString() } },
        audit: agentRows,
      },
    );
    expect(edited.sourcing.summary[3].value).toBe("S$12,000");
    expect(edited.launch.diff.find((r) => r.label === "Launch promo")?.value).toContain("2 for S$54.90");
    expect(edited.launch.stats[0].label).toContain("below");
    expect(edited.approvers[1].name).toBe("Someone Else");
    expect(edited.defaultActorId).toBe(second.id);
    expect(edited.phase).toBe("launch_pending");
  });

  it("formats whole and fractional amounts", () => {
    expect(sgdLabel(11_500)).toBe("S$11,500");
    expect(sgdLabel(32.9)).toBe("S$32.90");
    expect(sgdLabel(3910)).toBe("S$3,910");
  });
});

describe("approval screens render", () => {
  const view = approvalView(scenario, { approvals: {}, audit: [] });
  const noop = () => undefined;
  const modal = (actorSlot: 0 | 1) =>
    renderToStaticMarkup(
      createElement(PelitaApprovalModal, { data: view.sourcing, actor: view.approvers[actorSlot], busy: false, error: null, onCancel: noop, onApprove: noop }),
    );
  const launch = (phase: LaunchPhase, actorSlot: 0 | 1, sourcingBy = first.id) =>
    renderToStaticMarkup(
      createElement(PelitaLaunchApproval, {
        data: view.launch,
        phase,
        actor: view.approvers[actorSlot],
        sourcing: { by: first.name, approverId: sourcingBy, approvalId: scenario.sourcing.approvalId, at: T1.toISOString(), atLabel: "09:03" },
        launch: null,
        sentBack: null,
        busy: false,
        error: null,
        onApprove: noop,
        onSendBack: noop,
      }),
    );
  const button = (html: string, label: string) => {
    const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
    expect(match, label).not.toBeNull();
    return match![0];
  };
  const disabled = /\sdisabled(=""|\s|>)/;

  it("screen 02: shows the summary, the approver chip and a confirm that needs the tick", () => {
    const html = modal(0);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("HUMAN APPROVAL 1 OF 2");
    expect(html).toContain("Approve sourcing?");
    expect(html).toContain("The agent can&#x27;t buy anything until you approve.");
    expect(html).toContain(sgdLabel(scenario.sourcing.spendLimit));
    expect(html).toContain(first.roleDetail.replace("&", "&amp;"));
    expect(html).toContain(`Records as ${scenario.sourcing.approvalId}`);
    expect(html).toContain(scenario.sourcing.checkboxLabel.replace("'", "&#x27;"));
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(button(html, "Approve sourcing")).toMatch(disabled);
    expect(button(html, "Approve sourcing")).toContain("bg-human");
    expect(button(html, "Cancel")).not.toMatch(disabled);
    expect(html).not.toContain("Waiting for");
  });

  it("screen 02: another role sees 'Waiting for Category Manager approval' and cannot tick", () => {
    const html = modal(1);
    expect(html).toContain(`Waiting for ${first.role} approval`);
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(button(html, "Approve sourcing")).toMatch(disabled);
  });

  it("screen 05: shows the diff rows, side stats and a different-person approver", () => {
    const html = launch("launch_pending", 1);
    const text = html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
    expect(html).toContain("HUMAN APPROVAL 2 OF 2");
    expect(html).toContain("Approve listing and promo?");
    expect(html).toContain("This goes live to shoppers as soon as you approve.");
    expect(html).toContain(`Records as ${scenario.launchApproval.approvalId}`);
    for (const row of view.launch.diff) {
      expect(text).toContain(row.label);
      expect(text).toContain(row.value);
    }
    for (const stat of view.launch.stats) {
      expect(text).toContain(stat.value);
      expect(text).toContain(stat.label);
    }
    expect(html).toContain(`Sourcing approved by ${first.name}`);
    expect(html).not.toMatch(/insomnia/i);
    expect(button(html, "Approve and publish")).toMatch(disabled);
    expect(button(html, "Send back")).not.toMatch(disabled);
  });

  it("screen 05: the person who approved sourcing is told a different person must approve, and cannot act", () => {
    const html = launch("launch_pending", 0);
    expect(html).toContain(`${first.name} already approved sourcing. A different person must approve the listing and promo.`);
    expect(button(html, "Approve and publish")).toMatch(disabled);
    expect(button(html, "Send back")).toMatch(disabled);
  });

  it("screen 05: collapses to an outcome once sent back or approved", () => {
    expect(launch("sent_back", 1)).toContain("Sent back by");
    const approved = launch("launched", 1);
    expect(approved).toContain("Listing and promo approved by");
    expect(approved).not.toContain("Approve and publish");
  });

  it("keeps violet for the agent and navy for people: neither approval screen uses violet, and the approve buttons are navy", () => {
    for (const html of [modal(0), launch("launch_pending", 1)]) {
      expect(html).not.toMatch(/(text|bg|border|ring|accent)-agent|#5B3FD1|violet|purple/i);
      expect(html).toContain("text-human");
      expect(html).toContain("bg-human-50");
    }
    for (const file of [
      "src/components/pelita-ops/PelitaApprovalModal.tsx",
      "src/components/pelita-ops/PelitaLaunchApproval.tsx",
    ]) {
      expect(readFileSync(path.join(ROOT, file), "utf8"), file).not.toMatch(/(text|bg|border|ring|accent)-agent|#5B3FD1|violet|purple|SparkleIcon/i);
    }
  });

  it("console without an approval view keeps Approve off, with one it opens the flow", () => {
    const opsView = opsConsoleView(scenario, { approvals: {}, audit: [] });
    const without = renderToStaticMarkup(createElement(PelitaOpsConsole, { view: opsView }));
    expect(button(without, "Approve…")).toMatch(disabled);
    expect(without).toContain("Two-person approval is not part of this screen yet.");

    const withFlow = renderToStaticMarkup(createElement(PelitaOpsConsole, { view: opsView, approval: view }));
    expect(button(withFlow, "Approve…")).not.toMatch(disabled);
    expect(withFlow).not.toContain("Two-person approval is not part of this screen yet.");
    expect(withFlow).not.toContain('role="dialog"');
    expect(withFlow).toContain(`Switch to ${second.name}`);
  });

  it("console renders screen 05 once a drafted listing is sent for approval, with approver 2 signed in", () => {
    const state = {
      stage: 5,
      approvals: { sourcing: { approvalId: scenario.sourcing.approvalId, approverId: first.id, at: T1.toISOString() } },
      audit: agentRows,
    };
    const html = renderToStaticMarkup(
      createElement(PelitaOpsConsole, { view: opsConsoleView(scenario, state), approval: approvalView(scenario, state) }),
    );
    expect(html).toContain("Approve listing and promo?");
    expect(html).toContain(second.name);
    expect(html).toContain(`Switch to ${first.name}`);
    expect(html).not.toContain("SHELF AGENT");
    expect(button(html, "Approve and publish")).toMatch(disabled);
  });
});

describe("/demo/pelita/ops page", () => {
  it("passes the approval view built from the persisted state", async () => {
    openGate();
    useFakeRedis();
    const Page = (await import("@/app/demo/pelita/ops/page")).default;
    let element = await Page();
    expect(isValidElement(element)).toBe(true);
    let props = (element as ReactElement<{ view: OpsConsoleView; approval: ApprovalView }>).props;
    expect(props.approval.phase).toBe("sourcing_pending");

    await approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
    element = await Page();
    props = (element as ReactElement<{ view: OpsConsoleView; approval: ApprovalView }>).props;
    expect(props.approval.phase).toBe("stock_check");
    await reachApproval2();
    element = await Page();
    props = (element as ReactElement<{ view: OpsConsoleView; approval: ApprovalView }>).props;
    expect(props.approval.phase).toBe("launch_pending");
    expect(props.approval.recorded.sourcing).toMatchObject({ by: first.name, atLabel: "09:03" });
  });

  it("falls back to a new proposal when the store is not configured", async () => {
    openGate();
    vi.stubGlobal("fetch", vi.fn());
    const Page = (await import("@/app/demo/pelita/ops/page")).default;
    const element = await Page();
    expect((element as ReactElement<{ approval: ApprovalView }>).props.approval.phase).toBe("sourcing_pending");
  });
});

describe("approval API", () => {
  it("answers 404 when the gate is closed, the cookie is missing, or on production", async () => {
    const body = { action: "approve_sourcing", approverId: first.id, confirmed: true };
    expect((await approvalRoute(post(URL, body))).status).toBe(404);
    openGate();
    expect((await approvalRoute(post(URL, body, { cookie: false }))).status).toBe(404);
    process.env.VERCEL_ENV = "production";
    expect((await approvalRoute(post(URL, body))).status).toBe(404);
  });

  it("refuses cross-site writes, unknown actions, missing approvers and unreadable bodies, and 503s without a store", async () => {
    openGate();
    const body = { action: "approve_sourcing", approverId: first.id, confirmed: true };
    expect((await approvalRoute(post(URL, body, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await approvalRoute(post(URL, { ...body, action: "publish" }))).status).toBe(400);
    expect((await approvalRoute(post(URL, { action: "approve_sourcing" }))).status).toBe(400);
    expect((await approvalRoute(post(URL, null))).status).toBe(400);
    const garbled = new Request(URL, {
      method: "POST",
      headers: { origin: "https://x.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` },
      body: "{nope",
    });
    expect((await approvalRoute(garbled)).status).toBe(400);
    expect((await approvalRoute(post(URL, body))).status).toBe(503);
  });

  it("runs the two approvals end to end and maps refusals to 400, 403 and 409", async () => {
    openGate();
    useFakeRedis();
    const call = (action: string, approverId: string, confirmed?: boolean) => approvalRoute(post(URL, { action, approverId, confirmed }));

    expect((await call("approve_sourcing", second.id, true)).status).toBe(403);
    expect((await call("approve_sourcing", "nobody", true)).status).toBe(400);
    expect((await call("approve_sourcing", first.id, false)).status).toBe(400);
    expect((await call("approve_launch", second.id, true)).status).toBe(409);

    const one = await call("approve_sourcing", first.id, true);
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toBe("private, no-store");
    expect(await one.json()).toMatchObject({ isDemo: true, ok: true, changed: true, phase: "stock_check", approval: { by: first.name } });
    expect((await call("approve_sourcing", first.id, true)).status).toBe(409);

    const same = await call("approve_launch", first.id, true);
    expect(same.status).toBe(403);
    expect(await same.json()).toEqual({ error: "same_person" });

    const early = await call("approve_launch", second.id, true);
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "stock_check_required" });
    await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: instant });
    await continueFromStockCheck(scenario);
    const undrafted = await call("approve_launch", second.id, true);
    expect(undrafted.status).toBe(409);
    expect(await undrafted.json()).toEqual({ error: "listing_required" });
    await runListingDraft(scenario, { ...defaultListingDeps, wait: instant });
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);

    const two = await call("approve_launch", second.id, true);
    expect(two.status).toBe(200);
    expect(await two.json()).toMatchObject({
      phase: "launched",
      approval: { by: second.name, approvalId: scenario.launchApproval.approvalId },
      published: { approver: second.name, approvalId: scenario.launchApproval.approvalId },
    });
    expect((await getDemoState()).listed).toBe(true);

    expect((await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined))).status).toBe(200);
    expect(await phaseOf()).toBe("sourcing_pending");
    expect((await call("send_back", second.id)).status).toBe(409);
    await call("approve_sourcing", first.id, true);
    await reachApproval2();
    const back = await call("send_back", second.id);
    expect(await back.json()).toMatchObject({ ok: true, phase: "sent_back", sentBack: { by: second.name } });
  });
});

describe("approval code holds no fixture figures, and touches no identity provider", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("has no hardcoded names, ids, amounts or promo copy", () => {
    const fixtureValues = [
      ...scenario.approvers.flatMap((a) => [a.name, a.id, a.approvalId, a.role]),
      scenario.promo.ribbon,
      scenario.listing.title,
      scenario.proposal.supplier,
      scenario.claimsCheck.id,
      scenario.purchaseOrder.id,
      ...scenario.claimsCheck.removed.map((r) => r.claim),
    ];
    const figures = [
      scenario.sourcing.spendLimit,
      scenario.sourcing.maxUnits,
      scenario.promo.bundlePrice,
      scenario.promo.projectedWeek1Sales,
      scenario.promo.marginPct,
      scenario.promo.marginFloorPct,
      scenario.listing.onlineStock,
      scenario.erp.moveToOnline,
      scenario.proposal.price,
    ].map((n) => String(n).replace(/\./g, "\\.").replace(/(\d)(?=(\d{3})+$)/g, "$1,?"));
    for (const file of NEW_FILES) {
      const text = read(file);
      for (const value of fixtureValues) expect(text, `${file}: ${value}`).not.toContain(value);
      for (const figure of figures) expect(text, `${file}: ${figure}`).not.toMatch(new RegExp(`(?<![\\w.])${figure}(?![\\w.])`));
      expect(text, file).not.toMatch(/APR-\d|PO-\d|CMP-\d|LST-\d|S\$\d|cures insomnia|Priya|Daniel|Mei Ling|Arjun/);
    }
  });

  it("makes no identity-provider, database or env access, and only calls the approval route", () => {
    for (const file of NEW_FILES) {
      expect(read(file), file).not.toMatch(/auth0|management|@neondatabase|bi-db|bi-events|process\.env|redisPipeline|from "\.\.?\/(\.\.\/)?upstash"/i);
    }
    const client = read("src/lib/demo/approval-client.ts");
    expect([...client.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1])).toEqual(["/api/demo/pelita/approval"]);
    expect(read("src/components/pelita-ops/PelitaApprovalModal.tsx")).not.toMatch(/fetch\(/);
    expect(read("src/components/pelita-ops/PelitaLaunchApproval.tsx")).not.toMatch(/fetch\(/);
  });

  it("guards the write route with guardDemoWrite and the page with requirePresenterPage", () => {
    expect(read("src/app/api/demo/pelita/approval/route.ts")).toMatch(/guardDemoWrite\(req\)/);
    expect(read("src/app/demo/pelita/ops/page.tsx")).toMatch(/await requirePresenterPage\(\)/);
  });
});
