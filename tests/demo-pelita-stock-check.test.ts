import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "@/data/demo-scenario.json";
import { POST as approvalRoute } from "@/app/api/demo/pelita/approval/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { POST as listingRoute } from "@/app/api/demo/pelita/listing/route";
import { POST as stockCheckRoute } from "@/app/api/demo/pelita/stock-check/route";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { PelitaStockCheck } from "@/components/pelita-ops/PelitaStockCheck";
import { proxy } from "@/proxy";
import { approveLaunch, approveSourcing, sendBackLaunch } from "@/lib/demo/approval";
import { approvalView, launchPhase, launchRail, sgdLabel, type ApprovalView } from "@/lib/demo/approval-view";
import { listingDraftView } from "@/lib/demo/listing-view";
import { defaultListingDeps, runListingDraft, sendForApproval, setListingDeps } from "@/lib/demo/listing";
import { opsConsoleView } from "@/lib/demo/ops-console";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";
import { STATE_KEYS, STATE_KEY_NAMES, getDemoState, resetDemo } from "@/lib/demo/state";
import {
  DELAY_SECONDS,
  SupplierTimeout,
  continueFromStockCheck,
  defaultStockCheckDeps,
  mockErpCheck,
  mockSupplierCheck,
  randomDelayMs,
  runStockCheck,
  setStockCheckDeps,
  type StockCheckDeps,
} from "@/lib/demo/stock-check";
import { CHECK_ACTION, findStockCheck, purchaseOrderAction, stockCheckView, type StockCheckView } from "@/lib/demo/stock-check-view";
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
const STOCK_URL = "https://x.test/api/demo/pelita/stock-check";
const APPROVAL_URL = "https://x.test/api/demo/pelita/approval";
const LISTING_URL = "https://x.test/api/demo/pelita/listing";
const REDIS_URL = "https://redis.example";
const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};
const NEW_FILES = [
  "src/lib/demo/stock-check.ts",
  "src/lib/demo/stock-check-view.ts",
  "src/lib/demo/stock-check-client.ts",
  "src/components/pelita-ops/PelitaStockCheck.tsx",
  "src/app/api/demo/pelita/stock-check/route.ts",
  "src/lib/demo/listing.ts",
  "src/lib/demo/listing-view.ts",
  "src/lib/demo/published-view.ts",
  "src/components/pelita-ops/PelitaListingDraft.tsx",
  "src/app/api/demo/pelita/listing/route.ts",
];

let store: Map<string, string | string[]>;
let sent: Command[];
let fetched: string[];

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
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(url));
      return Response.json(fakeRedis(JSON.parse(String(init?.body)) as Command[]));
    }),
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
const T_CHECK = new Date("2026-11-25T01:04:15.000Z");
const T2 = new Date("2026-11-25T01:09:05.000Z");

/** Instant waits that remember every delay they were asked for. */
function instantDeps(overrides: Partial<StockCheckDeps> = {}): StockCheckDeps & { waits: number[] } {
  const waits: number[] = [];
  return {
    ...defaultStockCheckDeps,
    wait: async (ms) => {
      waits.push(ms);
    },
    now: () => T_CHECK,
    ...overrides,
    waits,
  };
}

const sourcingApproved = () => approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
const phaseOf = async () => launchPhase(scenario, await getDemoState());
/** After screen 03, approval 2 opens only once the agent has drafted the listing and a person has sent it for approval. */
async function draftAndSend(): Promise<void> {
  await runListingDraft(scenario, { ...defaultListingDeps, wait: async () => undefined });
  await sendForApproval(scenario, { approverId: first.id }, T2);
}
const writes = () => sent.filter(([name]) => name !== "GET" && name !== "LRANGE");

beforeEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  store = new Map(Object.entries(FOREIGN));
  sent = [];
  fetched = [];
});

afterEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  setStockCheckDeps(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the fixture data flows through the mock supplier and ERP", () => {
  it("the mocks return the fixture figures and tag them as demo data", async () => {
    const deps = instantDeps();
    const supplier = await mockSupplierCheck(scenario, deps);
    const erp = await mockErpCheck(scenario, deps);
    expect(supplier).toEqual({
      isDemo: true,
      source: scenario.supplier.source,
      supplier: scenario.supplier.name,
      availableUnits: scenario.supplier.availableUnits,
      leadTimeDays: scenario.supplier.leadTimeDays,
      costPrice: scenario.supplier.costPrice,
      moq: scenario.supplier.moq,
    });
    expect(erp).toEqual({
      isDemo: true,
      source: scenario.erp.source,
      dc: scenario.erp.dc,
      dcStock: scenario.erp.dcStock,
      moveToOnline: scenario.erp.moveToOnline,
      purchaseOrder: {
        id: scenario.purchaseOrder.id,
        units: scenario.purchaseOrder.units,
        unitCost: scenario.purchaseOrder.unitCost,
        total: scenario.purchaseOrder.total,
      },
    });
    expect(deps.waits).toHaveLength(2);
  });

  it("screen 03 copy and figures come from the fixture", () => {
    const view = stockCheckView(scenario, { approvals: {}, audit: [] });
    expect(view).toMatchObject({
      isDemo: true,
      demoTag: scenario.demoTag,
      kicker: "SHELF AGENT · SUPPLIER & STOCK CHECK",
      checkingLabel: "Checking supplier and ERP…",
      complete: false,
      doneLabel: null,
      title: `We can sell it today. ${scenario.erp.moveToOnline} units can move from our DC.`,
      sub: `Within approval ${scenario.sourcing.approvalId} (spend limit ${sgdLabel(scenario.sourcing.spendLimit)}).`,
      continueLabel: "Draft the listing →",
      sources: [scenario.supplier.source, scenario.erp.source],
      underLimit: true,
      canContinue: false,
    });
    expect(view.supplier.title).toBe(`Supplier · ${scenario.supplier.name}`);
    expect(view.supplier.cells.map((c) => [c.label, c.value, c.unit])).toEqual([
      ["Available", "6,000", "units"],
      ["Lead time", `${scenario.supplier.leadTimeDays} days`, "to our DC"],
      ["Cost price", sgdLabel(scenario.supplier.costPrice), scenario.supplier.costBasis],
      ["Minimum order", "480", "units (MOQ)"],
    ]);
    expect(view.erp.title).toBe(`Our ERP · ${scenario.erp.dc}`);
    expect(view.erp.cells.map((c) => [c.label, c.value, c.unit])).toEqual([
      ["DC stock", "1,200", "units, corporate wellness"],
      ["Move to online", String(scenario.erp.moveToOnline), "units, today"],
    ]);
    expect(view.erp.purchaseOrder).toEqual({
      label: "Purchase order drafted",
      value: `${scenario.purchaseOrder.id} · ${scenario.purchaseOrder.units} units · ${sgdLabel(scenario.purchaseOrder.total)}`,
      pill: "Under limit",
      underLimit: true,
    });
  });

  it("follows fixture edits, and an order over the spend limit needs a new approval and cannot go on", async () => {
    const edited = editedScenario((draft) => {
      draft.sourcing.spendLimit = 10_000;
      draft.purchaseOrder.underLimit = false;
      draft.erp.moveToOnline = 250;
      draft.supplier.name = "Someone Else Ltd";
    });
    const view = stockCheckView(edited, { approvals: {}, audit: [] });
    expect(view.underLimit).toBe(false);
    expect(view.erp.purchaseOrder.pill).toBe("Needs new approval");
    expect(view.title).toContain("needs a new approval");
    expect(view.supplier.title).toBe("Supplier · Someone Else Ltd");
    expect(view.erp.cells[1].value).toBe("250");

    useFakeRedis();
    await approveSourcing(edited, { approverId: first.id, confirmed: true }, T1);
    const result = await runStockCheck(edited, instantDeps());
    expect(result).toMatchObject({ ok: true, phase: "stock_check", check: { complete: true, underLimit: false, canContinue: false } });
    expect(await continueFromStockCheck(edited)).toEqual({ ok: false, reason: "over_limit" });
    expect(launchPhase(edited, await getDemoState())).toBe("stock_check");
  });

  it("a completed check appends the two agent audit rows from the mock results, dated when it finished", async () => {
    useFakeRedis();
    await sourcingApproved();
    const result = await runStockCheck(scenario, instantDeps());
    expect(result).toMatchObject({ ok: true, changed: true, phase: "stock_check" });

    const { audit, stage } = await getDemoState();
    expect(stage).toBe(3);
    const agent = scenario.audit.find((r) => r.actorKind === "agent")!.actor;
    expect(audit.slice(1)).toEqual([
      { at: T_CHECK.toISOString(), actorKind: "agent", actor: agent, action: CHECK_ACTION, source: "Supplier portal, ERP", ref: null },
      {
        at: T_CHECK.toISOString(),
        actorKind: "agent",
        actor: agent,
        action: purchaseOrderAction(scenario.purchaseOrder.units, scenario.purchaseOrder.total, scenario.erp.moveToOnline),
        source: "ERP",
        ref: scenario.purchaseOrder.id,
      },
    ]);
    expect(audit[2].action).toBe(`PO ${scenario.purchaseOrder.units} units, S$11,100; ${scenario.erp.moveToOnline} to online`);
    expect(findStockCheck(scenario, { audit })).toEqual({ at: T_CHECK.toISOString(), atLabel: "09:04" });
    if (!result.ok) throw new Error("unreachable");
    expect(result.check.doneLabel).toBe("Checked just now · 09:04");
    expect(stockCheckView(scenario, { approvals: {}, audit }, new Date("2026-11-25T01:30:00.000Z")).doneLabel).toBe("Checked · 09:04");
  });

  it("makes no call outside the demo store: every request goes to the redis host", async () => {
    useFakeRedis();
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    expect(fetched.length).toBeGreaterThan(0);
    for (const url of fetched) expect(url.startsWith(`${REDIS_URL}/`), url).toBe(true);
  });
});

describe("the delays are injectable, realistic and in order", () => {
  it("picks between 0.6 and 0.9 seconds", () => {
    expect(DELAY_SECONDS).toEqual({ min: 0.6, max: 0.9 });
    expect(randomDelayMs(() => 0)).toBe(600);
    expect(randomDelayMs(() => 0.9999999)).toBe(900);
    for (let i = 0; i < 200; i += 1) {
      const ms = randomDelayMs();
      expect(ms).toBeGreaterThanOrEqual(600);
      expect(ms).toBeLessThanOrEqual(900);
    }
    const ms = defaultStockCheckDeps.delayMs();
    expect(ms >= 600 && ms <= 900).toBe(true);
  });

  it("waits once for the supplier and then once for the ERP, and writes the result only after both", async () => {
    useFakeRedis();
    await sourcingApproved();
    const seen: { who: string; ms: number; complete: boolean }[] = [];
    const delays = [640, 870];
    const deps = instantDeps({
      delayMs: () => delays[seen.length],
      wait: async (ms) => {
        const state = await getDemoState();
        seen.push({ who: seen.length === 0 ? "supplier" : "erp", ms, complete: findStockCheck(scenario, state) !== null });
      },
    });
    await runStockCheck(scenario, deps);
    expect(seen).toEqual([
      { who: "supplier", ms: 640, complete: false },
      { who: "erp", ms: 870, complete: false },
    ]);
    expect(findStockCheck(scenario, await getDemoState())).not.toBeNull();
  });

  it("a supplier that times out leaves the check incomplete, writes no result and can be retried", async () => {
    useFakeRedis();
    await sourcingApproved();
    const failing = instantDeps({
      supplier: async () => {
        throw new SupplierTimeout();
      },
    });
    expect(await runStockCheck(scenario, failing)).toEqual({ ok: false, reason: "supplier_timeout" });
    const state = await getDemoState();
    expect(findStockCheck(scenario, state)).toBeNull();
    expect(state.audit).toHaveLength(1);
    expect(launchRail("stock_check", false, false).find((s) => s.n === 3)?.state).toBe("current");
    expect(await continueFromStockCheck(scenario)).toEqual({ ok: false, reason: "stock_check_incomplete" });

    expect(await runStockCheck(scenario, instantDeps())).toMatchObject({ ok: true, changed: true });
    expect(findStockCheck(scenario, await getDemoState())).not.toBeNull();
  });

  it("an error that is not a timeout is not swallowed", async () => {
    useFakeRedis();
    await sourcingApproved();
    const broken = instantDeps({
      erp: async () => {
        throw new Error("erp exploded");
      },
    });
    await expect(runStockCheck(scenario, broken)).rejects.toThrow("erp exploded");
    expect(findStockCheck(scenario, await getDemoState())).toBeNull();
  });

  it("refuses a drafted order the supplier cannot cover", async () => {
    const short = editedScenario((draft) => {
      draft.supplier.availableUnits = 500;
    });
    useFakeRedis();
    await approveSourcing(short, { approverId: first.id, confirmed: true }, T1);
    expect(await runStockCheck(short, instantDeps())).toEqual({ ok: false, reason: "supply_shortfall" });
    expect(findStockCheck(short, await getDemoState())).toBeNull();
  });
});

describe("ordering: the check follows approval 1 and approval 2 follows the check", () => {
  beforeEach(useFakeRedis);

  it("cannot run before approval 1, and then waits for nothing and writes nothing", async () => {
    const deps = instantDeps();
    expect(await runStockCheck(scenario, deps)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(deps.waits).toEqual([]);
    expect(writes()).toEqual([]);
    expect(await continueFromStockCheck(scenario)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(writes()).toEqual([]);
    expect((await getDemoState()).audit).toEqual([]);
  });

  it("cannot run after the proposal was rejected", async () => {
    await rejectProposal(scenario, T1);
    const deps = instantDeps();
    expect(await runStockCheck(scenario, deps)).toEqual({ ok: false, reason: "proposal_rejected" });
    expect(deps.waits).toEqual([]);
    expect(findStockCheck(scenario, await getDemoState())).toBeNull();
  });

  it("runs after approval 1: the phase is stock_check and approval 2 is refused until the presenter moves on", async () => {
    expect(await phaseOf()).toBe("sourcing_pending");
    await sourcingApproved();
    expect(await phaseOf()).toBe("stock_check");

    await runStockCheck(scenario, instantDeps());
    expect(await phaseOf()).toBe("stock_check");
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "stock_check_required" });
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toEqual({ ok: false, reason: "stock_check_required" });
    expect((await getDemoState()).approvals.launch).toBeUndefined();

    expect(await continueFromStockCheck(scenario)).toMatchObject({ ok: true, changed: true, phase: "listing_draft" });
    expect(await phaseOf()).toBe("listing_draft");
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "listing_required" });
    await draftAndSend();
    expect(await phaseOf()).toBe("launch_pending");
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toMatchObject({ ok: true, phase: "launched" });
  });

  it("continue needs a completed check, and a check that is still running blocks approval 2", async () => {
    await sourcingApproved();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = instantDeps({ wait: () => gate });
    const running = runStockCheck(scenario, slow);
    await vi.waitFor(async () => expect(await phaseOf()).toBe("stock_check"));

    expect(findStockCheck(scenario, await getDemoState())).toBeNull();
    expect(await continueFromStockCheck(scenario)).toEqual({ ok: false, reason: "stock_check_incomplete" });
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "stock_check_required" });
    release();
    expect(await running).toMatchObject({ ok: true });
    expect(findStockCheck(scenario, await getDemoState())).not.toBeNull();
  });

  it("runs once: a second run returns the recorded result without waiting or writing again", async () => {
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    const before = (await getDemoState()).audit.length;
    sent = [];
    const again = instantDeps();
    expect(await runStockCheck(scenario, again)).toMatchObject({ ok: true, changed: false, check: { complete: true } });
    expect(again.waits).toEqual([]);
    expect(writes()).toEqual([]);
    expect((await getDemoState()).audit).toHaveLength(before);

    await continueFromStockCheck(scenario);
    expect(await continueFromStockCheck(scenario)).toMatchObject({ ok: true, changed: false });
    expect(await runStockCheck(scenario, instantDeps())).toMatchObject({ ok: true, changed: false, phase: "listing_draft" });
  });

  it("refuses after the listing was sent back or approved", async () => {
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    await draftAndSend();
    await sendBackLaunch(scenario, { approverId: second.id }, T2);
    expect(await runStockCheck(scenario, instantDeps())).toEqual({ ok: false, reason: "sent_back" });
    expect(await continueFromStockCheck(scenario)).toEqual({ ok: false, reason: "sent_back" });

    await resetDemo();
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    await draftAndSend();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    expect(await runStockCheck(scenario, instantDeps())).toEqual({ ok: false, reason: "already_launched" });
  });

  it("rail step 3 is done only once the check has completed", async () => {
    const stateOf = (phase: ReturnType<typeof launchRail>) => phase.map((s) => s.state);
    expect(launchRail("stock_check").find((s) => s.state === "current")).toMatchObject({ n: 3, label: "Stock check", kind: "agent" });
    expect(launchRail("stock_check").filter((s) => s.state === "done").map((s) => s.n)).toEqual([1, 2]);

    expect(launchRail("launch_pending")[2].state).toBe("done");
    expect(launchRail("launch_pending", false, true)[2].state).toBe("done");
    expect(launchRail("launch_pending", false, false)[2].state).toBe("upcoming");
    expect(launchRail("sent_back", false, false)[2].state).toBe("upcoming");
    expect(launchRail("launched", false, false)[2].state).toBe("upcoming");
    expect(stateOf(launchRail("launch_pending", false, false)).slice(0, 2)).toEqual(["done", "done"]);

    await sourcingApproved();
    const view = async () => stockCheckView(scenario, await getDemoState());
    expect((await view()).complete).toBe(false);
    await runStockCheck(scenario, instantDeps());
    expect((await view()).complete).toBe(true);
    await continueFromStockCheck(scenario);
    expect(launchRail(await phaseOf(), false, (await view()).complete)[2].state).toBe("done");
  });

  it("leaves step 4 (the listing draft) to a later step: no listing, claims or live state is written", async () => {
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    const state = await getDemoState();
    expect(state.listed).toBe(false);
    expect(state.audit.map((r) => r.ref)).toEqual([scenario.sourcing.approvalId, null, scenario.purchaseOrder.id]);
    expect(JSON.stringify(state.audit)).not.toContain(scenario.claimsCheck.id);
    expect(JSON.stringify(state.audit)).not.toContain(scenario.listing.id);
  });
});

describe("the gate: page, proxy and API", () => {
  it("the stock-check API answers 404 when the gate is closed or the cookie is missing, including on production", async () => {
    const body = { action: "run" };
    expect((await stockCheckRoute(post(STOCK_URL, body))).status).toBe(404);
    openGate();
    expect((await stockCheckRoute(post(STOCK_URL, body, { cookie: false }))).status).toBe(404);
    process.env.VERCEL_ENV = "production";
    delete process.env.KB_DEMO_TRACK;
    expect((await stockCheckRoute(post(STOCK_URL, body))).status).toBe(404);
    process.env.KB_DEMO_TRACK = "pelita";
    expect((await stockCheckRoute(post(STOCK_URL, body, { cookie: false }))).status).toBe(404);
    expect((await stockCheckRoute(post(STOCK_URL, body))).status).toBe(503);
  });

  it("refuses cross-site writes, unknown actions and unreadable bodies, and 503s without a store", async () => {
    openGate();
    expect((await stockCheckRoute(post(STOCK_URL, { action: "run" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await stockCheckRoute(post(STOCK_URL, { action: "publish" }))).status).toBe(400);
    expect((await stockCheckRoute(post(STOCK_URL, {}))).status).toBe(400);
    expect((await stockCheckRoute(post(STOCK_URL, null))).status).toBe(400);
    const garbled = new Request(STOCK_URL, {
      method: "POST",
      headers: { origin: "https://x.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` },
      body: "{nope",
    });
    expect((await stockCheckRoute(garbled)).status).toBe(400);
    expect((await stockCheckRoute(post(STOCK_URL, { action: "run" }))).status).toBe(503);
  });

  it("runs end to end through the route and maps refusals to 409 and 504", async () => {
    openGate();
    useFakeRedis();
    const waits: number[] = [];
    setStockCheckDeps({ wait: async (ms) => void waits.push(ms), now: () => T_CHECK });
    const call = (action: string) => stockCheckRoute(post(STOCK_URL, { action }));
    const approve = (action: string, approverId: string) => approvalRoute(post(APPROVAL_URL, { action, approverId, confirmed: true }));

    const early = await call("run");
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "sourcing_required" });
    expect(waits).toEqual([]);

    expect((await approve("approve_sourcing", first.id)).status).toBe(200);
    expect((await call("continue")).status).toBe(409);

    const run = await call("run");
    expect(run.status).toBe(200);
    expect(run.headers.get("cache-control")).toBe("private, no-store");
    const data = (await run.json()) as { isDemo: boolean; phase: string; check: StockCheckView };
    expect(data).toMatchObject({ isDemo: true, ok: true, changed: true, phase: "stock_check", check: { isDemo: true, complete: true, doneLabel: "Checked just now · 09:04" } });
    expect(waits).toHaveLength(2);

    const blocked = await approve("approve_launch", second.id);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "stock_check_required" });

    expect(await (await call("continue")).json()).toMatchObject({ ok: true, phase: "listing_draft" });
    const undrafted = await approve("approve_launch", second.id);
    expect(undrafted.status).toBe(409);
    expect(await undrafted.json()).toEqual({ error: "listing_required" });
    setListingDeps({ wait: async () => undefined });
    expect((await listingRoute(post(LISTING_URL, { action: "draft" }))).status).toBe(200);
    expect((await listingRoute(post(LISTING_URL, { action: "send", approverId: first.id }))).status).toBe(200);
    setListingDeps(null);
    expect((await approve("approve_launch", second.id)).status).toBe(200);

    await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined));
    await approve("approve_sourcing", first.id);
    setStockCheckDeps({
      wait: async () => undefined,
      supplier: async () => {
        throw new SupplierTimeout();
      },
    });
    const timeout = await call("run");
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toEqual({ error: "supplier_timeout" });
  });

  it("the proxy 404s /demo/pelita/ops without the gate and the cookie, and lets the API through to its own gate", async () => {
    const page = (cookie?: string) =>
      proxy(new NextRequest("https://x.test/demo/pelita/ops", cookie ? { headers: { cookie } } : undefined));
    const token = signPresenterToken(SECRET);
    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);

    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(200);
    process.env.VERCEL_ENV = "production";
    delete process.env.KB_DEMO_TRACK;
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
    process.env.KB_DEMO_TRACK = "pelita";
    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}x`)).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(200);
    delete process.env.VERCEL_ENV;

    expect((await proxy(new NextRequest(STOCK_URL, { method: "POST" }))).status).toBe(200);
    expect((await stockCheckRoute(new Request(STOCK_URL, { method: "POST", headers: { origin: "https://x.test" } }))).status).toBe(404);
  });

  it("the ops page is a 404 without the gate and the cookie, and passes the stock check view when open", async () => {
    const Page = (await import("@/app/demo/pelita/ops/page")).default;
    await expect(Page()).rejects.toThrow();
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    await expect(Page()).rejects.toThrow();
    process.env.VERCEL_ENV = "production";
    delete process.env.KB_DEMO_TRACK;
    cookieJar.value = signPresenterToken(SECRET);
    await expect(Page()).rejects.toThrow();
    process.env.KB_DEMO_TRACK = "pelita";
    cookieJar.value = undefined;
    await expect(Page()).rejects.toThrow();
    cookieJar.value = signPresenterToken(SECRET);
    expect(isValidElement(await Page())).toBe(true);
    delete process.env.VERCEL_ENV;

    useFakeRedis();
    type Props = { approval: ApprovalView; stockCheck: StockCheckView };
    let element = await Page();
    expect(isValidElement(element)).toBe(true);
    let props = (element as ReactElement<Props>).props;
    expect(props.approval.phase).toBe("sourcing_pending");
    expect(props.stockCheck).toMatchObject({ complete: false, isDemo: true });

    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    element = await Page();
    props = (element as ReactElement<Props>).props;
    expect(props.approval.phase).toBe("stock_check");
    expect(props.stockCheck.complete).toBe(true);
  });

  it("the new route and page use the existing guards", () => {
    const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
    expect(read("src/app/api/demo/pelita/stock-check/route.ts")).toMatch(/guardDemoWrite\(req\)/);
    expect(read("src/app/demo/pelita/ops/page.tsx")).toMatch(/await requirePresenterPage\(\)/);
  });
});

describe("screen 03 renders", () => {
  const doneRows = (s: typeof scenario) => [
    { at: T_CHECK.toISOString(), actorKind: "agent" as const, actor: "Shelf Agent", action: CHECK_ACTION, source: "x", ref: null },
    { at: T_CHECK.toISOString(), actorKind: "agent" as const, actor: "Shelf Agent", action: "po", source: "x", ref: s.purchaseOrder.id },
  ];
  const complete = stockCheckView(scenario, { approvals: {}, audit: doneRows(scenario) }, T_CHECK);
  const idle = stockCheckView(scenario, { approvals: {}, audit: [] });
  const noop = () => undefined;
  const render = (data: StockCheckView, status: "running" | "done" | "failed", error: string | null = null) =>
    renderToStaticMarkup(createElement(PelitaStockCheck, { data, status, error, busy: false, onRetry: noop, onContinue: noop }));
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const disabled = /\sdisabled(=""|\s|>)/;
  const button = (html: string, label: string) => {
    const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
    expect(match, label).not.toBeNull();
    return match![0];
  };

  it("while checking: the pill and skeletons show, no result figures do, and the button is off", () => {
    const html = render(idle, "running");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("SHELF AGENT · SUPPLIER &amp; STOCK CHECK");
    expect(text(html)).toContain("Checking supplier and ERP…");
    expect(text(html)).toContain("Supplier · ");
    expect(html).toContain("animate-pulse");
    expect(text(html)).not.toContain("6,000");
    expect(text(html)).not.toContain(scenario.purchaseOrder.id);
    expect(button(html, "Draft the listing →")).toMatch(disabled);
  });

  it("when done: every figure from screen 03, the green pill, the demo tags and an enabled button", () => {
    const html = render(complete, "done");
    const copy = text(html);
    expect(copy).toContain(complete.title);
    expect(copy).toContain(complete.sub);
    expect(copy).toContain("Checked just now · 09:04");
    for (const cell of [...complete.supplier.cells, ...complete.erp.cells]) {
      expect(copy).toContain(cell.label);
      expect(copy).toContain(cell.value);
      expect(copy).toContain(cell.unit);
    }
    expect(copy).toContain(complete.erp.purchaseOrder.value);
    expect(copy).toContain("Under limit");
    expect(copy).toContain(`Sources: ${scenario.supplier.source} · ${scenario.erp.source}`);
    expect((html.match(/data-demo-data/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-busy="false"');
    expect(button(html, "Draft the listing →")).not.toMatch(disabled);
  });

  it("over the limit: the pill is a warning and the button stays off", () => {
    const edited = editedScenario((draft) => {
      draft.sourcing.spendLimit = 10_000;
      draft.purchaseOrder.underLimit = false;
    });
    const view = stockCheckView(edited, { approvals: {}, audit: doneRows(edited) }, T_CHECK);
    expect(view).toMatchObject({ complete: true, underLimit: false, canContinue: false });
    const html = render(view, "done");
    expect(html).toContain('data-po-pill="over"');
    expect(text(html)).toContain("Needs new approval");
    expect(html).toContain("text-warning-text");
    expect(button(html, "Draft the listing →")).toMatch(disabled);
  });

  it("when the supplier does not answer: a warning pill, the error and a Retry button", () => {
    const html = render(idle, "failed", "The supplier portal did not answer in time.");
    expect(text(html)).toContain("Supplier portal did not answer");
    expect(html).toContain('role="alert"');
    expect(button(html, "Retry")).not.toMatch(disabled);
    expect(html).not.toContain("Draft the listing");
  });

  it("keeps violet for the agent and never uses the navy of human approvals", () => {
    for (const html of [render(idle, "running"), render(complete, "done"), render(idle, "failed")]) {
      expect(html).toContain("shadow-[inset_8px_0_0_var(--color-agent)]");
      expect(html).toContain("text-agent");
      expect(html).not.toMatch(/(text|bg|border|ring|accent)-human|#1E3A8A/i);
    }
    expect(render(idle, "running")).toContain("bg-agent-50");
    expect(render(complete, "done")).toContain("bg-success-50");
    expect(readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaStockCheck.tsx"), "utf8")).not.toMatch(/-human|HumanIcon|#1E3A8A/i);
  });

  it("the console shows screen 03 after approval 1 with step 3 outlined, screen 04 once the presenter moves on, and screen 05 once the draft is sent", () => {
    const base = { approvals: { sourcing: { approvalId: scenario.sourcing.approvalId, approverId: first.id, at: T1.toISOString() } }, audit: [] };
    const state = { ...base, stage: 3 };
    const html = renderToStaticMarkup(
      createElement(PelitaOpsConsole, { view: opsConsoleView(scenario, state), approval: approvalView(scenario, state), stockCheck: stockCheckView(scenario, state) }),
    );
    expect(html).toContain("data-stock-check");
    expect(html).toContain("Checking supplier and ERP…");
    expect(html).not.toContain("Approve listing and promo?");
    expect(approvalView(scenario, state).defaultActorId).toBe(first.id);
    expect(html).toContain(`Switch to ${second.name}`);
    const current = /<li aria-current="step"[^>]*>(.*?)<\/li>/.exec(html);
    expect(current?.[1]).toContain("Stock check");
    expect(current?.[0]).toContain("border-agent");

    const agentRows = scenario.audit.filter((row) => row.actorKind === "agent");
    const past = { ...base, stage: 4, audit: agentRows };
    const draft = renderToStaticMarkup(
      createElement(PelitaOpsConsole, {
        view: opsConsoleView(scenario, past),
        approval: approvalView(scenario, past),
        stockCheck: stockCheckView(scenario, past),
        listing: listingDraftView(scenario, past),
      }),
    );
    expect(draft).toContain("data-listing-draft");
    expect(draft).not.toContain("Approve listing and promo?");
    expect(draft).not.toContain("data-stock-check");

    const sentOn = { ...past, stage: 5 };
    const later = renderToStaticMarkup(
      createElement(PelitaOpsConsole, {
        view: opsConsoleView(scenario, sentOn),
        approval: approvalView(scenario, sentOn),
        stockCheck: stockCheckView(scenario, sentOn),
        listing: listingDraftView(scenario, sentOn),
      }),
    );
    expect(later).toContain("Approve listing and promo?");
    expect(later).not.toContain("data-stock-check");
    expect(later).not.toContain("data-listing-draft");
  });
});

describe("reset clears the stock check", () => {
  beforeEach(useFakeRedis);

  it("adds no state key beyond the fixed list, and every write stays inside it", async () => {
    expect(STATE_KEY_NAMES).toEqual(["stage", "approvals", "audit", "listed", "claim:sourcing", "claim:launch", "opening", "elapsed", "epoch"]);
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    await resetDemo();
    expect(sent.length).toBeGreaterThan(0);
    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(String(target).startsWith("kb:demo:pelita:")).toBe(true);
      expect(STATE_KEYS).toContain(target);
    }
  });

  it("resetDemo and the reset route wipe the check, the stage and the audit rows, and reopen approval 1", async () => {
    openGate();
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    expect(findStockCheck(scenario, await getDemoState())).not.toBeNull();
    expect(await phaseOf()).toBe("stock_check");

    const res = await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined));
    expect(res.status).toBe(200);
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(stockCheckView(scenario, await getDemoState()).complete).toBe(false);
    expect(await phaseOf()).toBe("sourcing_pending");
    expect(await runStockCheck(scenario, instantDeps())).toEqual({ ok: false, reason: "sourcing_required" });
    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);

    await sourcingApproved();
    const rerun = instantDeps();
    expect(await runStockCheck(scenario, rerun)).toMatchObject({ ok: true, changed: true });
    expect(rerun.waits).toHaveLength(2);
  });

  it("a reset also clears a check that was moved past screen 03", async () => {
    await sourcingApproved();
    await runStockCheck(scenario, instantDeps());
    await continueFromStockCheck(scenario);
    expect((await getDemoState()).stage).toBe(4);
    expect(await resetDemo()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(findStockCheck(scenario, await getDemoState())).toBeNull();
  });
});

describe("stock check code holds no fixture figures, and makes no outside call", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("has no hardcoded names, ids, amounts or supplier and ERP figures", () => {
    const fixtureValues = [
      ...scenario.approvers.flatMap((a) => [a.name, a.id, a.approvalId, a.role]),
      scenario.supplier.name,
      scenario.supplier.source,
      scenario.supplier.costBasis,
      scenario.erp.dc,
      scenario.erp.source,
      scenario.erp.dcStockHeldFor,
      scenario.erp.checkedLabel,
      scenario.purchaseOrder.id,
      scenario.claimsCheck.id,
      scenario.listing.id,
      scenario.promo.ribbon,
      scenario.proposal.supplier,
    ];
    const figures = [
      scenario.sourcing.spendLimit,
      scenario.sourcing.maxUnits,
      scenario.supplier.availableUnits,
      scenario.supplier.costPrice,
      scenario.supplier.moq,
      scenario.erp.dcStock,
      scenario.erp.moveToOnline,
      scenario.purchaseOrder.units,
      scenario.purchaseOrder.total,
    ].map((n) => String(n).replace(/\./g, "\\.").replace(/(\d)(?=(\d{3})+$)/g, "$1,?"));
    for (const file of NEW_FILES) {
      const code = read(file);
      for (const value of fixtureValues) expect(code, `${file}: ${value}`).not.toContain(value);
      for (const figure of figures) expect(code, `${file}: ${figure}`).not.toMatch(new RegExp(`(?<![\\w.])${figure}(?![\\w.])`));
      expect(code, file).not.toMatch(/APR-\d|PO-\d|CMP-\d|LST-\d|S\$\d|Mei Ling|Arjun|Evergreen|Tuas/);
    }
  });

  it("makes no identity-provider, database, env or network access, and the client calls only its own route", () => {
    for (const file of NEW_FILES) {
      expect(read(file), file).not.toMatch(/auth0|management|@neondatabase|bi-db|bi-events|process\.env|redisPipeline|from "\.\.?\/(\.\.\/)?upstash"|https?:\/\//i);
    }
    const client = read("src/lib/demo/stock-check-client.ts");
    expect([...client.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1])).toEqual(["/api/demo/pelita/stock-check"]);
    for (const file of NEW_FILES.filter((f) => f !== "src/lib/demo/stock-check-client.ts")) {
      expect(read(file), file).not.toMatch(/\bfetch\(/);
    }
  });

  it("the logic modules import only other demo modules", () => {
    for (const file of ["src/lib/demo/stock-check.ts", "src/lib/demo/stock-check-view.ts"]) {
      for (const match of read(file).matchAll(/^import .* from "([^"]+)";$/gm)) expect(match[1], file).toMatch(/^\.\//);
    }
  });
});
