import { REJECT_ACTION_PREFIX, clockLabel, findRejection, proposalStatus, type Rejection } from "./ops-console";
import type { Scenario } from "./scenario";
import { SLOT_GUARDS, appendAudit, getDemoSnapshot, getDemoState, releaseGuard, takeGuard, type DemoAuditRow } from "./state";

export type RejectResult =
  | { ok: true; changed: boolean; status: "rejected"; rejection: Rejection }
  | { ok: false; status: "approved" };

/**
 * new -> rejected. The only write is one row on the fixed audit list, so
 * resetDemo() puts the proposal back to new. Rejecting twice is a no-op, and a
 * proposal that already has its sourcing approval cannot be rejected.
 */
export async function rejectProposal(scenario: Scenario, now: Date = new Date()): Promise<RejectResult> {
  const { state, epoch } = await getDemoSnapshot();
  const status = proposalStatus(scenario, state);
  if (status === "approved") return { ok: false, status };
  const existing = findRejection(scenario, state);
  if (existing) return { ok: true, changed: false, status: "rejected", rejection: existing };

  const approver = scenario.approvers.find((a) => a.slot === 1);
  if (!approver) throw new Error("Scenario has no first approver");
  const row: DemoAuditRow = {
    at: now.toISOString(),
    actorKind: "human",
    actor: approver.name,
    action: `${REJECT_ACTION_PREFIX}: ${scenario.proposal.title}`,
    source: "Ops console",
    ref: scenario.gap.id,
  };
  const rejection = { by: row.actor, at: row.at, atLabel: clockLabel(row.at) };

  // Rejecting takes the sourcing slot's guard, so it and "Approve sourcing" cannot both win.
  const guard = SLOT_GUARDS.sourcing;
  const claimed = await takeGuard(guard, "reject", epoch);
  if (!claimed.won) {
    return claimed.heldBy === "reject" ? { ok: true, changed: false, status: "rejected", rejection } : { ok: false, status: "approved" };
  }
  try {
    const latest = await getDemoState();
    if (latest.approvals.sourcing) return { ok: false, status: "approved" };
    const again = findRejection(scenario, latest);
    if (again) return { ok: true, changed: false, status: "rejected", rejection: again };
    await appendAudit(row, epoch);
  } catch (error) {
    await releaseGuard(guard, epoch);
    throw error;
  }
  return { ok: true, changed: true, status: "rejected", rejection };
}
