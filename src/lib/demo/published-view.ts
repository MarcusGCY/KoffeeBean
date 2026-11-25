import { clockLabel } from "./ops-console";
import { findDetectionRow } from "./opening";
import type { Scenario } from "./scenario";
import { DEFAULT_ELAPSED_MODE, type DemoAuditRow, type DemoState, type ElapsedMode } from "./state";

/** Where a shopper finds the published listing. */
export const STOREFRONT_PATH = "/demo/pelita";
export const STOREFRONT_LINK_LABEL = "View it on the storefront →";

/** `elapsedMode` is the presenter's choice. It is the fixture figure unless it is set to "real". */
type PublishedState = Pick<DemoState, "approvals" | "audit" | "listed"> & { elapsedMode?: ElapsedMode };

/** "7 min 11 s", or "45 s" under a minute. */
export function durationLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds % 60} s`;
}

/** The storefront row that says the product went live. Its time ends the detection-to-live gap. */
export function findPublishRow(scenario: Scenario, state: Pick<DemoState, "audit">): DemoAuditRow | null {
  const refs = scenario.audit.filter((f) => f.actorKind === "system" && f.ref !== null).map((f) => f.ref);
  return state.audit.find((row) => row.actorKind === "system" && row.ref !== null && refs.includes(row.ref)) ?? null;
}

/**
 * Detection to live. By default it is the fixture's own figure (`fromRows` is false). When the
 * presenter has switched to the real time it is measured from the real "Spotted gap" row to the
 * real publish row, and still falls back to the fixture's figure when either row is missing or
 * the clock runs backwards.
 */
export function detectionToLive(
  scenario: Scenario,
  state: Pick<DemoState, "audit"> & { elapsedMode?: ElapsedMode },
): { seconds: number; label: string; fromRows: boolean } {
  if ((state.elapsedMode ?? DEFAULT_ELAPSED_MODE) !== "real") {
    return { seconds: scenario.timing.totalSeconds, label: scenario.timing.totalLabel, fromRows: false };
  }
  const start = Date.parse(findDetectionRow(scenario, state)?.at ?? "");
  const end = Date.parse(findPublishRow(scenario, state)?.at ?? "");
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    const seconds = Math.round((end - start) / 1000);
    return { seconds, label: durationLabel(seconds), fromRows: true };
  }
  return { seconds: scenario.timing.totalSeconds, label: scenario.timing.totalLabel, fromRows: false };
}

export type PublishedView = {
  title: string;
  line1: string;
  line2: string;
  /** "Live in about 7 minutes": the detection-to-live time, rounded to whole minutes. */
  liveIn: string;
  liveInDetail: string;
  atLabel: string;
  approver: string;
  approvalId: string;
};

/**
 * What screen 06 says about a publish. Null until approval 2 has really listed the
 * product, so nothing here appears for a draft that is still waiting.
 */
export function publishedView(scenario: Scenario, state: PublishedState): PublishedView | null {
  const approval = state.approvals.launch;
  if (!state.listed || !approval) return null;
  const person = scenario.approvers.find((a) => a.id === approval.approverId);
  const approver = person?.name ?? approval.approverId;
  const atLabel = clockLabel(findPublishRow(scenario, state)?.at ?? approval.at);
  const elapsed = detectionToLive(scenario, state);
  const minutes = Math.max(1, Math.round(elapsed.seconds / 60));

  return {
    title: scenario.published.toastTitle,
    line1: `Published ${atLabel} · approved by ${approver}`,
    line2: `${approval.approvalId} · ${scenario.listing.onlineStock} units online`,
    liveIn: `Live in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
    liveInDetail: `${elapsed.label} from detection to live`,
    atLabel,
    approver,
    approvalId: approval.approvalId,
  };
}
