import { sgdLabel } from "./approval-view";
import { clockLabel, formatCount } from "./ops-console";
import type { Scenario } from "./scenario";
import type { DemoAuditRow, DemoState } from "./state";

export const STOCK_CHECK_KICKER = "SHELF AGENT · SUPPLIER & STOCK CHECK";
export const CHECKING_LABEL = "Checking supplier and ERP…";
export const CHECK_ACTION = "Checked supplier and DC stock";
export const CHECK_SOURCE = "Supplier portal, ERP";
export const PO_SOURCE = "ERP";

type StockCheckState = Pick<DemoState, "approvals" | "audit">;

/** The agent name every agent audit row carries, taken from the fixture's own agent rows. */
export function agentActor(scenario: Scenario): string {
  const row = scenario.audit.find((r) => r.actorKind === "agent");
  if (!row) throw new Error("Scenario has no agent audit row");
  return row.actor;
}

/** The audit action of the purchase-order row, built from the figures it records. */
export function purchaseOrderAction(units: number, total: number, moveToOnline: number): string {
  return `PO ${units} units, ${sgdLabel(total)}; ${moveToOnline} to online`;
}

export type RecordedStockCheck = { at: string; atLabel: string };

/**
 * The check has really completed once both of its agent audit rows exist: the
 * supplier-and-DC row and the purchase-order row. The runner writes them in one
 * request, so there is no half-done state to read.
 */
export function findStockCheck(scenario: Scenario, state: Pick<DemoState, "audit">): RecordedStockCheck | null {
  const agent = (row: DemoAuditRow) => row.actorKind === "agent";
  const checked = state.audit.find((row) => agent(row) && row.action === CHECK_ACTION);
  const ordered = state.audit.find((row) => agent(row) && row.ref === scenario.purchaseOrder.id);
  if (!checked || !ordered) return null;
  return { at: ordered.at, atLabel: clockLabel(ordered.at) };
}

export type StockCell = { label: string; value: string; unit: string; emphasis?: boolean };

export type StockCheckView = {
  isDemo: true;
  demoTag: string;
  kicker: string;
  checkingLabel: string;
  complete: boolean;
  /** Null until the check has completed. */
  doneLabel: string | null;
  title: string;
  sub: string;
  supplier: { title: string; source: string; cells: StockCell[] };
  erp: {
    title: string;
    source: string;
    cells: StockCell[];
    purchaseOrder: { label: string; value: string; pill: string; underLimit: boolean };
  };
  sources: string[];
  continueLabel: string;
  /** Over the spend limit means a new approval is needed, so the agent cannot go on. */
  underLimit: boolean;
  canContinue: boolean;
};

/** "Checked just now" plus the clock time for a fresh result, and plain "Checked" once it is a minute old. */
function checkedLabel(check: RecordedStockCheck, now: Date): string {
  const age = now.getTime() - Date.parse(check.at);
  const fresh = Number.isFinite(age) && age >= 0 && age < 60_000;
  return `Checked ${fresh ? "just now · " : "· "}${check.atLabel}`;
}

/** The held-for text loses a trailing channel tag in brackets under the DC stock figure. */
function plainHeldFor(text: string): string {
  return text.replace(/\s*\([^)]*\)\s*$/, "");
}

/** Everything screen 03 renders, from the fixture and the persisted audit rows. */
export function stockCheckView(scenario: Scenario, state: StockCheckState, now: Date = new Date()): StockCheckView {
  const { supplier, erp, purchaseOrder, sourcing } = scenario;
  const recorded = findStockCheck(scenario, state);
  const underLimit = purchaseOrder.total <= sourcing.spendLimit;
  const limit = `${sourcing.approvalId} (spend limit ${sgdLabel(sourcing.spendLimit)})`;

  return {
    isDemo: true,
    demoTag: scenario.demoTag,
    kicker: STOCK_CHECK_KICKER,
    checkingLabel: CHECKING_LABEL,
    complete: recorded !== null,
    doneLabel: recorded ? checkedLabel(recorded, now) : null,
    title: underLimit
      ? `We can sell it today. ${erp.moveToOnline} units can move from our DC.`
      : "This order is over the spend limit and needs a new approval.",
    sub: underLimit
      ? `Within approval ${limit}.`
      : `The purchase order of ${sgdLabel(purchaseOrder.total)} is above approval ${limit}.`,
    supplier: {
      title: `Supplier · ${supplier.name}`,
      source: supplier.source,
      cells: [
        { label: "Available", value: formatCount(supplier.availableUnits), unit: "units" },
        { label: "Lead time", value: `${supplier.leadTimeDays} days`, unit: "to our DC" },
        { label: "Cost price", value: sgdLabel(supplier.costPrice), unit: supplier.costBasis },
        { label: "Minimum order", value: formatCount(supplier.moq), unit: "units (MOQ)" },
      ],
    },
    erp: {
      title: `Our ERP · ${erp.dc}`,
      source: erp.source,
      cells: [
        { label: "DC stock", value: formatCount(erp.dcStock), unit: `units, ${plainHeldFor(erp.dcStockHeldFor)}` },
        { label: "Move to online", value: formatCount(erp.moveToOnline), unit: "units, today", emphasis: true },
      ],
      purchaseOrder: {
        label: "Purchase order drafted",
        value: `${purchaseOrder.id} · ${purchaseOrder.units} units · ${sgdLabel(purchaseOrder.total)}`,
        pill: underLimit ? "Under limit" : "Needs new approval",
        underLimit,
      },
    },
    sources: [supplier.source, erp.source],
    continueLabel: "Draft the listing →",
    underLimit,
    canContinue: recorded !== null && underLimit,
  };
}
