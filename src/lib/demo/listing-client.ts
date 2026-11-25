import type { ApprovalView, LaunchPhase } from "./approval-view";
import type { ListingRefusal } from "./listing";
import { DESCRIPTION_MAX, type ListingDraftView } from "./listing-view";

/** Browser calls to the presenter-gated listing API. Same-origin, so the presenter cookie travels with them. */

export class ListingRefused extends Error {
  constructor(readonly reason: ListingRefusal | "store_unavailable" | "failed") {
    super(reason);
  }
}

async function send(body: Record<string, unknown>): Promise<{ phase: LaunchPhase; draft: ListingDraftView; launch: ApprovalView["launch"] }> {
  const res = await fetch("/api/demo/pelita/listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ListingRefused((typeof data.error === "string" ? data.error : "failed") as ListingRefused["reason"]);
  }
  return { phase: data.phase as LaunchPhase, draft: data.draft as ListingDraftView, launch: data.launch as ApprovalView["launch"] };
}

export const runListingDraftRequest = () => send({ action: "draft" });
export const editListingRequest = (approverId: string, description: string) => send({ action: "edit", approverId, description });
export const sendForApprovalRequest = (approverId: string) => send({ action: "send", approverId });

export function listingMessage(error: unknown): string {
  const reason = error instanceof ListingRefused ? error.reason : "failed";
  switch (reason) {
    case "claim_not_allowed":
      return "The claims check does not allow that wording. Keep the removed claim out of the description.";
    case "invalid_description":
      return `Write a description of 1 to ${DESCRIPTION_MAX} characters.`;
    case "claims_failed":
      return "The claims check did not pass. Try again.";
    case "already_sent":
      return "The listing was already sent for approval.";
    case "draft_required":
      return "The agent has not finished the draft yet.";
    case "stock_check_required":
      return "The stock check must be finished first.";
    case "sourcing_required":
      return "Sourcing must be approved first.";
    case "proposal_rejected":
      return "The proposal was rejected. Reset the demo to start again.";
    case "sent_back":
      return "The listing was sent back. Reset the demo to start again.";
    case "already_launched":
      return "The listing is already published.";
    case "store_unavailable":
      return "The demo store is unavailable. Try again.";
    default:
      return "Could not update the listing. Try again.";
  }
}
