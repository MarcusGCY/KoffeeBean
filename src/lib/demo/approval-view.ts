import { clockLabel, findRejection, railSteps, type RailStep } from "./ops-console";
import type { Scenario } from "./scenario";
import { STOCK_CHECK_STAGE, type DemoState } from "./state";

/**
 * Where the launch flow stands. It is derived from the persisted state, never stored.
 * "stock_check" is the agent's supplier and ERP check (screen 03) between approval 1
 * and the approval-2 screen: approval 2 is refused until the presenter moves past it.
 */
export type LaunchPhase = "sourcing_pending" | "rejected" | "stock_check" | "launch_pending" | "sent_back" | "launched";

/** The audit action that marks a listing sent back. Its `ref` is the listing id. */
export const SEND_BACK_ACTION_PREFIX = "Sent back listing and promo";

type ApprovalState = Pick<DemoState, "approvals" | "audit"> & { stage?: number };

export type ApproverView = {
  id: string;
  name: string;
  initials: string;
  role: string;
  roleDetail: string;
  slot: 1 | 2;
  approvalId: string;
};

export type RecordedApproval = { by: string; approverId: string; approvalId: string; at: string; atLabel: string };

export type SummaryRow = { label: string; value: string; emphasis?: boolean };

export type ApprovalView = {
  phase: LaunchPhase;
  approvers: ApproverView[];
  /** The mock person acting on first load: whoever the current stage waits for. */
  defaultActorId: string;
  sourcing: {
    kicker: string;
    title: string;
    sub: string;
    summary: SummaryRow[];
    approver: ApproverView;
    chip: string;
    checkboxLabel: string;
    confirmLabel: string;
    cancelLabel: string;
    waitingLabel: string;
  };
  launch: {
    kicker: string;
    title: string;
    sub: string;
    chip: string;
    diff: SummaryRow[];
    stats: { value: string; label: string }[];
    checkboxLabel: string;
    confirmLabel: string;
    sendBackLabel: string;
    approver: ApproverView;
  };
  recorded: { sourcing: RecordedApproval | null; launch: RecordedApproval | null };
  sentBack: { by: string; atLabel: string } | null;
};

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Whole amounts get no decimals and the rest get two, so a spend limit reads as a limit and a price as a price. */
export function sgdLabel(amount: number): string {
  const whole = Number.isInteger(amount);
  const text = amount.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `S$${text}`;
}

function shortDate(day: string): string {
  return SHORT_DATE.format(new Date(`${day}T00:00:00Z`));
}

export function findSendBack(scenario: Scenario, state: Pick<DemoState, "audit">): { by: string; at: string; atLabel: string } | null {
  const row = state.audit.find((r) => r.ref === scenario.listing.id && r.action.startsWith(SEND_BACK_ACTION_PREFIX));
  return row ? { by: row.actor.split(" · ")[0], at: row.at, atLabel: clockLabel(row.at) } : null;
}

export function launchPhase(scenario: Scenario, state: ApprovalState): LaunchPhase {
  if (state.approvals.launch) return "launched";
  if (state.approvals.sourcing) {
    if (findSendBack(scenario, state)) return "sent_back";
    return state.stage === STOCK_CHECK_STAGE ? "stock_check" : "launch_pending";
  }
  return findRejection(scenario, state) ? "rejected" : "sourcing_pending";
}

/**
 * The rail for each phase. The approval modal over screen 01 outlines step 2, the
 * stock check outlines step 3, the launch approval outlines step 5 and an approved
 * launch outlines "Live". Step 3 shows done only once the check has really completed
 * (`stockChecked`), so a launch screen reached without it leaves step 3 open.
 */
export function launchRail(phase: LaunchPhase, modalOpen = false, stockChecked = true): RailStep[] {
  switch (phase) {
    case "sourcing_pending":
      return railSteps(modalOpen ? 2 : 1);
    case "rejected":
      return railSteps(1);
    case "stock_check":
      return railSteps(3);
    case "launch_pending":
    case "sent_back":
      return withStockCheck(railSteps(5), stockChecked);
    case "launched":
      return withStockCheck(railSteps(6), stockChecked);
  }
}

function withStockCheck(steps: RailStep[], stockChecked: boolean): RailStep[] {
  return stockChecked ? steps : steps.map((step) => (step.n === 3 ? { ...step, state: "upcoming" as const } : step));
}

function approverView(scenario: Scenario, slot: 1 | 2): ApproverView {
  const approver = scenario.approvers.find((a) => a.slot === slot);
  if (!approver) throw new Error(`Scenario has no approver for slot ${slot}`);
  return { ...approver };
}

function recorded(scenario: Scenario, approval: DemoState["approvals"]["sourcing"]): RecordedApproval | null {
  if (!approval) return null;
  const person = scenario.approvers.find((a) => a.id === approval.approverId);
  return {
    by: person?.name ?? approval.approverId,
    approverId: approval.approverId,
    approvalId: approval.approvalId,
    at: approval.at,
    atLabel: clockLabel(approval.at),
  };
}

/** "Tuas distribution centre" reads "Tuas DC" in the diff rows. */
function shortDc(name: string): string {
  return name.replace(/\s+distribution centre$/i, " DC");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Everything screens 02 and 05 render, from the fixture and the persisted approval state. */
export function approvalView(scenario: Scenario, state: ApprovalState): ApprovalView {
  const { proposal, sourcing, listing, promo, claimsCheck, erp, launchApproval } = scenario;
  const product = scenario.catalogue.find((item) => item.id === proposal.productId);
  if (!product) throw new Error(`Proposal product ${proposal.productId} is not in the catalogue`);
  const first = approverView(scenario, 1);
  const second = approverView(scenario, 2);
  const phase = launchPhase(scenario, state);
  const productLine = `${product.name} · ${product.size.replace(/\bcapsules\b/, "caps")}`;
  const category = product.subcategory ? `${product.category} › ${product.subcategory}` : product.category;
  const aboveFloor = promo.marginPct >= promo.marginFloorPct;

  return {
    phase,
    approvers: [first, second],
    defaultActorId: phase === "sourcing_pending" || phase === "rejected" || phase === "stock_check" ? first.id : second.id,
    sourcing: {
      kicker: "HUMAN APPROVAL 1 OF 2",
      title: "Approve sourcing?",
      sub: "The agent can't buy anything until you approve.",
      summary: [
        { label: "Product", value: productLine },
        { label: "Supplier", value: proposal.supplier },
        { label: "First order", value: `Up to ${sourcing.maxUnits} units (about ${sourcing.approxWeeks} weeks)` },
        { label: "Spend limit", value: sgdLabel(sourcing.spendLimit), emphasis: true },
      ],
      approver: first,
      chip: `Records as ${sourcing.approvalId}`,
      checkboxLabel: sourcing.checkboxLabel,
      confirmLabel: "Approve sourcing",
      cancelLabel: "Cancel",
      waitingLabel: `Waiting for ${first.role} approval`,
    },
    launch: {
      kicker: "HUMAN APPROVAL 2 OF 2",
      title: "Approve listing and promo?",
      sub: "This goes live to shoppers as soon as you approve.",
      chip: `Records as ${launchApproval.approvalId}`,
      diff: [
        { label: "New product", value: productLine },
        { label: "Category", value: category },
        { label: "Price", value: sgdLabel(listing.price) },
        { label: "Launch promo", value: `${promo.ribbon} · ${shortDate(promo.startsOn)} – ${shortDate(promo.endsOn)}` },
        { label: "Online stock", value: `${listing.onlineStock} units from ${shortDc(erp.dc)}` },
        { label: "Claims check", value: `${capitalise(claimsCheck.status)} · ${claimsCheck.id}` },
      ],
      stats: [
        { value: `${promo.marginPct}%`, label: `margin at promo, ${aboveFloor ? "above" : "below"} ${promo.marginFloorPct}% floor` },
        { value: sgdLabel(promo.projectedWeek1Sales), label: "projected sales, week 1" },
      ],
      checkboxLabel: launchApproval.checkboxLabel,
      confirmLabel: "Approve and publish",
      sendBackLabel: "Send back",
      approver: second,
    },
    recorded: { sourcing: recorded(scenario, state.approvals.sourcing), launch: recorded(scenario, state.approvals.launch) },
    sentBack: findSendBack(scenario, state),
  };
}
