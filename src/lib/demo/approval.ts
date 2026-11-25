import { SEND_BACK_ACTION_PREFIX, findSendBack, launchPhase, sgdLabel, type LaunchPhase, type RecordedApproval } from "./approval-view";
import { publishAuditRow } from "./listing-view";
import { clockLabel } from "./ops-console";
import { publishedView, type PublishedView } from "./published-view";
import type { Scenario } from "./scenario";
import { PUBLISHED_STAGE, appendAudit, commitApproval, getDemoState, type ApprovalSlot, type CommitExtras, type DemoAuditRow } from "./state";

export type ApprovalRefusal =
  | "unknown_approver"
  | "wrong_approver"
  | "same_person"
  | "confirmation_required"
  | "already_approved"
  | "proposal_rejected"
  | "sourcing_required"
  | "stock_check_required"
  | "listing_required"
  | "sent_back";

export type ApprovalInput = { approverId: string; confirmed: boolean };

export type ApprovalResult =
  | { ok: true; changed: boolean; phase: LaunchPhase; approval: RecordedApproval; published: PublishedView | null }
  | { ok: false; reason: ApprovalRefusal };

export type SendBackResult =
  | { ok: true; changed: boolean; phase: "sent_back"; sentBack: { by: string; atLabel: string } }
  | { ok: false; reason: ApprovalRefusal };

const SLOT_NUMBER: Record<ApprovalSlot, 1 | 2> = { sourcing: 1, launch: 2 };

const refuse = (reason: ApprovalRefusal): { ok: false; reason: ApprovalRefusal } => ({ ok: false, reason });

/**
 * Who may act on a slot. Approvers are the two fixture people and nobody else,
 * and the person who gave approval 1 can never give approval 2.
 */
function authorise(
  scenario: Scenario,
  slot: ApprovalSlot,
  approverId: string,
  sourcingApproverId: string | undefined,
): { ok: true; actor: Scenario["approvers"][number] } | { ok: false; reason: ApprovalRefusal } {
  const actor = scenario.approvers.find((a) => a.id === approverId);
  if (!actor) return refuse("unknown_approver");
  if (slot === "launch" && sourcingApproverId === actor.id) return refuse("same_person");
  if (actor.slot !== SLOT_NUMBER[slot]) return refuse("wrong_approver");
  return { ok: true, actor };
}

function humanRow(actor: Scenario["approvers"][number], at: Date, action: string, ref: string): DemoAuditRow {
  return { at: at.toISOString(), actorKind: "human", actor: `${actor.name} · ${actor.role}`, action, source: "Ops console", ref };
}

async function approve(scenario: Scenario, slot: ApprovalSlot, input: ApprovalInput, now: Date): Promise<ApprovalResult> {
  const state = await getDemoState();
  const who = authorise(scenario, slot, input.approverId, state.approvals.sourcing?.approverId);
  if (!who.ok) return who;
  if (input.confirmed !== true) return refuse("confirmation_required");
  if (state.approvals[slot]) return refuse("already_approved");

  const phase = launchPhase(scenario, state);
  if (slot === "sourcing" && phase === "rejected") return refuse("proposal_rejected");
  if (slot === "launch") {
    if (!state.approvals.sourcing) return refuse("sourcing_required");
    if (phase === "sent_back") return refuse("sent_back");
    if (phase === "stock_check") return refuse("stock_check_required");
    if (phase === "listing_draft") return refuse("listing_required");
  }

  const { actor } = who;
  const approvalId = slot === "sourcing" ? scenario.sourcing.approvalId : scenario.launchApproval.approvalId;
  const action =
    slot === "sourcing" ? `Approved sourcing, spend limit ${sgdLabel(scenario.sourcing.spendLimit)}` : "Approved listing and promo";
  const approval = { approvalId, approverId: actor.id, at: now.toISOString() };
  const row = humanRow(actor, now, action, approvalId);

  // Approval 2 publishes: the approval, the storefront audit row, the listed flag and the
  // stage all go in one request, so the product is never listed without its approval.
  const published: DemoAuditRow | null = slot === "launch" ? { ...publishAuditRow(scenario), at: now.toISOString() } : null;
  const extras: CommitExtras = published ? { rows: [published], listed: true, stage: PUBLISHED_STAGE } : {};
  if (!(await commitApproval(slot, approval, row, extras))) return refuse("already_approved");

  return {
    ok: true,
    changed: true,
    phase: slot === "sourcing" ? "stock_check" : "launched",
    approval: { by: actor.name, ...approval, atLabel: clockLabel(approval.at) },
    published: published
      ? publishedView(scenario, { approvals: { ...state.approvals, [slot]: approval }, audit: [...state.audit, row, published], listed: true })
      : null,
  };
}

/** Approval 1: the category manager signs off the sourcing and its spend limit (screen 02). */
export function approveSourcing(scenario: Scenario, input: ApprovalInput, now: Date = new Date()): Promise<ApprovalResult> {
  return approve(scenario, "sourcing", input, now);
}

/** Approval 2: a different person signs off the listing and promo (screen 05). */
export function approveLaunch(scenario: Scenario, input: ApprovalInput, now: Date = new Date()): Promise<ApprovalResult> {
  return approve(scenario, "launch", input, now);
}

/**
 * Screen 05 "Send back": appends one audit row, so resetDemo() reopens the
 * approval. Sending back twice is a no-op, and an approved launch cannot be sent back.
 */
export async function sendBackLaunch(scenario: Scenario, input: { approverId: string }, now: Date = new Date()): Promise<SendBackResult> {
  const state = await getDemoState();
  const who = authorise(scenario, "launch", input.approverId, state.approvals.sourcing?.approverId);
  if (!who.ok) return who;
  if (state.approvals.launch) return refuse("already_approved");
  if (!state.approvals.sourcing) return refuse("sourcing_required");
  const phase = launchPhase(scenario, state);
  if (phase === "stock_check") return refuse("stock_check_required");
  if (phase === "listing_draft") return refuse("listing_required");
  const existing = findSendBack(scenario, state);
  if (existing) return { ok: true, changed: false, phase: "sent_back", sentBack: { by: existing.by, atLabel: existing.atLabel } };

  const row = humanRow(who.actor, now, `${SEND_BACK_ACTION_PREFIX}: ${scenario.listing.title}`, scenario.listing.id);
  await appendAudit(row);
  return { ok: true, changed: true, phase: "sent_back", sentBack: { by: who.actor.name, atLabel: clockLabel(row.at) } };
}
