import { launchPhase } from "./approval-view";
import type { Scenario } from "./scenario";
import { PAST_STOCK_CHECK_STAGE, STOCK_CHECK_STAGE, appendAuditRows, getDemoState, setStage, type DemoAuditRow } from "./state";
import {
  CHECK_ACTION,
  CHECK_SOURCE,
  PO_SOURCE,
  agentActor,
  findStockCheck,
  purchaseOrderAction,
  stockCheckView,
  type StockCheckView,
} from "./stock-check-view";

/** The mock calls take between 0.6 and 0.9 seconds each, so the "Checking…" state is visible. */
export const DELAY_SECONDS = { min: 0.6, max: 0.9 } as const;

export function randomDelayMs(random: () => number = Math.random): number {
  const { min, max } = DELAY_SECONDS;
  return Math.round((min + random() * (max - min)) * 1000);
}

/** Raised by a supplier check that did not answer in time. */
export class SupplierTimeout extends Error {
  constructor() {
    super("supplier_timeout");
  }
}

export type SupplierCheck = {
  isDemo: true;
  source: string;
  supplier: string;
  availableUnits: number;
  leadTimeDays: number;
  costPrice: number;
  moq: number;
};

export type ErpCheck = {
  isDemo: true;
  source: string;
  dc: string;
  dcStock: number;
  moveToOnline: number;
  purchaseOrder: { id: string; units: number; unitCost: number; total: number };
};

/**
 * Everything that makes the check slow or fallible is injected, so tests pass
 * an instant `wait` and a failing `supplier` without fake timers. The defaults
 * are mocks that read the fixture only: nothing here reaches an outside host.
 */
export type StockCheckDeps = {
  wait: (ms: number) => Promise<void>;
  delayMs: () => number;
  now: () => Date;
  supplier: (scenario: Scenario, deps: StockCheckDeps) => Promise<SupplierCheck>;
  erp: (scenario: Scenario, deps: StockCheckDeps) => Promise<ErpCheck>;
};

/** Mock supplier portal: the fixture's supplier figures after a realistic pause. */
export async function mockSupplierCheck(scenario: Scenario, deps: Pick<StockCheckDeps, "wait" | "delayMs">): Promise<SupplierCheck> {
  await deps.wait(deps.delayMs());
  const { supplier } = scenario;
  return {
    isDemo: true,
    source: supplier.source,
    supplier: supplier.name,
    availableUnits: supplier.availableUnits,
    leadTimeDays: supplier.leadTimeDays,
    costPrice: supplier.costPrice,
    moq: supplier.moq,
  };
}

/** Mock ERP: the fixture's DC stock, the move to online and the drafted purchase order. */
export async function mockErpCheck(scenario: Scenario, deps: Pick<StockCheckDeps, "wait" | "delayMs">): Promise<ErpCheck> {
  await deps.wait(deps.delayMs());
  const { erp, purchaseOrder } = scenario;
  return {
    isDemo: true,
    source: erp.source,
    dc: erp.dc,
    dcStock: erp.dcStock,
    moveToOnline: erp.moveToOnline,
    purchaseOrder: { id: purchaseOrder.id, units: purchaseOrder.units, unitCost: purchaseOrder.unitCost, total: purchaseOrder.total },
  };
}

export const defaultStockCheckDeps: StockCheckDeps = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs: () => randomDelayMs(),
  now: () => new Date(),
  supplier: mockSupplierCheck,
  erp: mockErpCheck,
};

let configured: StockCheckDeps = defaultStockCheckDeps;

/** Test seam for the API route, which has no other way to take dependencies. Pass null to restore the defaults. */
export function setStockCheckDeps(deps: Partial<StockCheckDeps> | null): void {
  configured = deps ? { ...defaultStockCheckDeps, ...deps } : defaultStockCheckDeps;
}

export type StockCheckRefusal =
  | "sourcing_required"
  | "proposal_rejected"
  | "sent_back"
  | "already_launched"
  | "stock_check_incomplete"
  | "over_limit"
  | "supply_shortfall"
  | "supplier_timeout";

export type StockCheckResult =
  | { ok: true; changed: boolean; phase: "stock_check" | "listing_draft" | "launch_pending"; check: StockCheckView }
  | { ok: false; reason: StockCheckRefusal };

const refuse = (reason: StockCheckRefusal): { ok: false; reason: StockCheckRefusal } => ({ ok: false, reason });

/** Why the check cannot run or go on in this phase, or null when it can. */
function blocked(phase: ReturnType<typeof launchPhase>): StockCheckRefusal | null {
  switch (phase) {
    case "sourcing_pending":
      return "sourcing_required";
    case "rejected":
      return "proposal_rejected";
    case "sent_back":
      return "sent_back";
    case "launched":
      return "already_launched";
    default:
      return null;
  }
}

/**
 * Screen 03. Only after approval 1 does the agent check the supplier and then the
 * ERP, each after its own delay. The two audit rows that mark the check as done are
 * written together once both calls have answered, so a check that is still running
 * or failed leaves nothing behind except the stage marker. A completed check is
 * returned as it is and never run twice.
 */
export async function runStockCheck(scenario: Scenario, deps: StockCheckDeps = configured): Promise<StockCheckResult> {
  const before = await getDemoState();
  const phase = launchPhase(scenario, before);
  const stop = blocked(phase);
  if (stop) return refuse(stop);

  if (findStockCheck(scenario, before)) {
    return { ok: true, changed: false, phase: phase === "listing_draft" || phase === "launch_pending" ? phase : "stock_check", check: stockCheckView(scenario, before, deps.now()) };
  }

  if (before.stage !== STOCK_CHECK_STAGE) await setStage(STOCK_CHECK_STAGE);

  let supplier: SupplierCheck;
  let erp: ErpCheck;
  try {
    supplier = await deps.supplier(scenario, deps);
    erp = await deps.erp(scenario, deps);
  } catch (error) {
    if (error instanceof SupplierTimeout) return refuse("supplier_timeout");
    throw error;
  }

  const { units } = erp.purchaseOrder;
  if (units < supplier.moq || units > supplier.availableUnits) return refuse("supply_shortfall");

  // Another request may have finished the same check while this one waited, and a reset
  // may have wiped the approval it needs: rows must never land after a reset.
  const latest = await getDemoState();
  const stale = blocked(launchPhase(scenario, latest));
  if (stale) return refuse(stale);
  if (!findStockCheck(scenario, latest)) {
    const at = deps.now().toISOString();
    const agent = agentActor(scenario);
    const rows: DemoAuditRow[] = [
      { at, actorKind: "agent", actor: agent, action: CHECK_ACTION, source: CHECK_SOURCE, ref: null },
      {
        at,
        actorKind: "agent",
        actor: agent,
        action: purchaseOrderAction(erp.purchaseOrder.units, erp.purchaseOrder.total, erp.moveToOnline),
        source: PO_SOURCE,
        ref: erp.purchaseOrder.id,
      },
    ];
    await appendAuditRows(rows);
  }

  const after = await getDemoState();
  return { ok: true, changed: true, phase: "stock_check", check: stockCheckView(scenario, after, deps.now()) };
}

/**
 * "Draft the listing →": moves past screen 03 to the listing draft (screen 04). Needs
 * a completed check that is within the spend limit. The agent's draft is written by
 * the listing route, and approval 2 opens only after that draft is sent for approval.
 * Once past screen 03 a repeat call changes nothing, so it can never move the stage back.
 */
export async function continueFromStockCheck(scenario: Scenario, now: () => Date = () => new Date()): Promise<StockCheckResult> {
  const state = await getDemoState();
  const phase = launchPhase(scenario, state);
  const stop = blocked(phase);
  if (stop) return refuse(stop);

  const view = stockCheckView(scenario, state, now());
  if (!view.complete) return refuse("stock_check_incomplete");
  if (!view.underLimit) return refuse("over_limit");
  if (phase === "listing_draft" || phase === "launch_pending") {
    return { ok: true, changed: false, phase, check: view };
  }
  await setStage(PAST_STOCK_CHECK_STAGE);
  return { ok: true, changed: true, phase: "listing_draft", check: view };
}
