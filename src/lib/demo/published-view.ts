import { clockLabel } from "./ops-console";
import type { Scenario } from "./scenario";
import type { DemoState } from "./state";

/** Where a shopper finds the published listing. */
export const STOREFRONT_PATH = "/demo/pelita";
export const STOREFRONT_LINK_LABEL = "View it on the storefront →";

type PublishedState = Pick<DemoState, "approvals" | "audit" | "listed">;

export type PublishedView = {
  title: string;
  line1: string;
  line2: string;
  /** "Live in about 7 minutes": the fixture's detection-to-live time, rounded to whole minutes. */
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
  const live = state.audit.find((row) => row.actorKind === "system" && row.ref !== null && scenario.audit.some((f) => f.actorKind === "system" && f.ref === row.ref));
  const atLabel = clockLabel(live?.at ?? approval.at);
  const minutes = Math.max(1, Math.round(scenario.timing.totalSeconds / 60));

  return {
    title: scenario.published.toastTitle,
    line1: `Published ${atLabel} · approved by ${approver}`,
    line2: `${approval.approvalId} · ${scenario.listing.onlineStock} units online`,
    liveIn: `Live in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`,
    liveInDetail: `${scenario.timing.totalLabel} from detection to live`,
    atLabel,
    approver,
    approvalId: approval.approvalId,
  };
}
