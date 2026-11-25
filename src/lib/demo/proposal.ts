import { REJECT_ACTION_PREFIX, clockLabel, findRejection, proposalStatus, type Rejection } from "./ops-console";
import type { Scenario } from "./scenario";
import { appendAudit, getDemoState, type DemoAuditRow } from "./state";

export type RejectResult =
  | { ok: true; changed: boolean; status: "rejected"; rejection: Rejection }
  | { ok: false; status: "approved" };

/**
 * new -> rejected. The only write is one row on the fixed audit list, so
 * resetDemo() puts the proposal back to new. Rejecting twice is a no-op, and a
 * proposal that already has its sourcing approval cannot be rejected.
 */
export async function rejectProposal(scenario: Scenario, now: Date = new Date()): Promise<RejectResult> {
  const state = await getDemoState();
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
  await appendAudit(row);
  return { ok: true, changed: true, status: "rejected", rejection: { by: row.actor, at: row.at, atLabel: clockLabel(row.at) } };
}
