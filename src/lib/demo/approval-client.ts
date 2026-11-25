import type { ApprovalRefusal } from "./approval";
import type { LaunchPhase, RecordedApproval } from "./approval-view";
import type { PublishedView } from "./published-view";

/** Same-origin calls to the public Pelita approval API. A cross-site request is refused. */

type Action = "approve_sourcing" | "approve_launch" | "send_back";

export class ApprovalRefused extends Error {
  constructor(readonly reason: ApprovalRefusal | "store_unavailable" | "reset_during_request" | "failed") {
    super(reason);
  }
}

async function send(action: Action, approverId: string, confirmed?: boolean): Promise<Record<string, unknown>> {
  const res = await fetch("/api/demo/pelita/approval", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, approverId, confirmed }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason = typeof data.error === "string" ? data.error : "failed";
    throw new ApprovalRefused(reason as ApprovalRefused["reason"]);
  }
  return data;
}

export async function approveRequest(
  slot: "sourcing" | "launch",
  approverId: string,
): Promise<{ phase: LaunchPhase; approval: RecordedApproval; published: PublishedView | null }> {
  const data = await send(slot === "sourcing" ? "approve_sourcing" : "approve_launch", approverId, true);
  return { phase: data.phase as LaunchPhase, approval: data.approval as RecordedApproval, published: (data.published as PublishedView | null) ?? null };
}

export async function sendBackRequest(approverId: string): Promise<{ by: string; atLabel: string }> {
  const data = await send("send_back", approverId);
  return data.sentBack as { by: string; atLabel: string };
}

export function refusalMessage(error: unknown): string {
  const reason = error instanceof ApprovalRefused ? error.reason : "failed";
  switch (reason) {
    case "same_person":
      return "The person who approved sourcing cannot also approve the launch.";
    case "wrong_approver":
      return "This approval belongs to the other approver.";
    case "already_approved":
      return "This step is already approved.";
    case "confirmation_required":
      return "Tick the confirmation first.";
    case "proposal_rejected":
      return "The proposal was rejected. Reset the demo to start again.";
    case "sourcing_required":
      return "Sourcing must be approved first.";
    case "stock_check_required":
      return "The stock check must be finished first.";
    case "listing_required":
      return "The listing draft must be sent for approval first.";
    case "sent_back":
      return "The listing was sent back. Reset the demo to start again.";
    case "reset_during_request":
      return "The demo was reset while this was in flight, so nothing was recorded. Reload and start again.";
    case "store_unavailable":
      return "The demo store is unavailable. Try again.";
    default:
      return "Could not record the approval. Try again.";
  }
}
