import { findRejection } from "@/lib/demo/ops-console";
import { loadScenario } from "@/lib/demo/scenario";
import { appendAuditRows, getDemoSnapshot, type DemoAuditRow } from "@/lib/demo/state";
import { findSignal, markSignalFromBot, yuuWindowMinutes } from "./db";
import type { YuuSignalView } from "./types";

export const YUU_SIGNAL_ACTION_PREFIX = "yuu (simulated) signal";
export const YUU_BOT_ACTION_PREFIX = "BI bot rationale";

export type SignalAccept =
  | { ok: true; idempotent: boolean; signal: YuuSignalView; proposalRef: string; proposalStatus: "awaiting_approval_1" }
  | { ok: false; http: 409 | 422; reason: string };

/** 0–1, or a 0–100 percentage. */
export function normaliseConfidence(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value;
  if (value > 1 && value <= 100) return value / 100;
  return null;
}

function filed(rows: readonly DemoAuditRow[], ref: string): boolean {
  return rows.some((row) => row.ref === ref && typeof row.action === "string" && row.action.startsWith(YUU_BOT_ACTION_PREFIX));
}

/**
 * Records the BI bot's signal and files the Pelita product proposal for approval 1.
 * The sku must already be shortlisted or escalated by the detector, and it must be the
 * demand-gap product the existing approval flow knows. A second call returns the same proposal.
 */
export async function acceptBiSignal(input: {
  sku: string;
  rationale: string;
  confidence: number;
  windowMinutes?: number;
  now?: Date;
}): Promise<SignalAccept> {
  const scenario = loadScenario();
  const windowMinutes = yuuWindowMinutes(input.windowMinutes);
  const signal = await findSignal(input.sku, windowMinutes);
  if (!signal) return { ok: false, http: 422, reason: "no signal for this sku in the current window" };
  if (signal.status !== "shortlisted" && signal.status !== "escalated") {
    return { ok: false, http: 422, reason: signal.reason ?? "signal is not shortlisted or escalated" };
  }
  if (signal.sku !== scenario.proposal.productId) {
    return { ok: false, http: 422, reason: "sku is not the open demand-gap product" };
  }
  if (signal.source === "bi_bot" && signal.proposalRef) {
    return { ok: true, idempotent: true, signal, proposalRef: signal.proposalRef, proposalStatus: "awaiting_approval_1" };
  }

  const snapshot = await getDemoSnapshot();
  if (snapshot.state.approvals.sourcing || snapshot.state.approvals.launch) {
    return { ok: false, http: 409, reason: "approval 1 already recorded" };
  }
  if (findRejection(scenario, snapshot.state)) {
    return { ok: false, http: 409, reason: "proposal was rejected" };
  }

  const now = input.now ?? new Date();
  const at = now.toISOString();
  const percent = Math.round(input.confidence * 100);
  const rows: DemoAuditRow[] = [
    {
      at,
      actorKind: "agent",
      actor: "yuu loyalty (simulated)",
      action: `${YUU_SIGNAL_ACTION_PREFIX}: ${signal.productName} score ${signal.score}, ${signal.distinctMembers} members, qty ${signal.totalQty}`,
      source: "yuu (simulated)",
      ref: scenario.gap.id,
    },
    {
      at,
      actorKind: "agent",
      actor: "BI bot",
      action: `${YUU_BOT_ACTION_PREFIX} (${percent}%): ${input.rationale}`,
      source: "yuu (simulated)",
      ref: scenario.gap.id,
    },
  ];
  if (!filed(snapshot.state.audit, scenario.gap.id)) await appendAuditRows(rows, snapshot.epoch);

  const claimed = await markSignalFromBot(signal.sku, windowMinutes, input.rationale, scenario.gap.id);
  if (claimed) {
    return { ok: true, idempotent: false, signal: claimed, proposalRef: scenario.gap.id, proposalStatus: "awaiting_approval_1" };
  }
  const again = await findSignal(signal.sku, windowMinutes);
  if (again?.source === "bi_bot" && again.proposalRef) {
    return { ok: true, idempotent: true, signal: again, proposalRef: again.proposalRef, proposalStatus: "awaiting_approval_1" };
  }
  return { ok: false, http: 409, reason: "signal changed before it could be filed" };
}
