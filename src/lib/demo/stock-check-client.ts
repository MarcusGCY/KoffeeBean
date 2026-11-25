import type { LaunchPhase } from "./approval-view";
import type { StockCheckRefusal } from "./stock-check";
import type { StockCheckView } from "./stock-check-view";

/** Browser calls to the presenter-gated stock-check API. Same-origin, so the presenter cookie travels with them. */

export class StockCheckRefused extends Error {
  constructor(readonly reason: StockCheckRefusal | "store_unavailable" | "reset_during_request" | "failed") {
    super(reason);
  }
}

async function send(action: "run" | "continue"): Promise<{ phase: LaunchPhase; check: StockCheckView }> {
  const res = await fetch("/api/demo/pelita/stock-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new StockCheckRefused((typeof data.error === "string" ? data.error : "failed") as StockCheckRefused["reason"]);
  }
  return { phase: data.phase as LaunchPhase, check: data.check as StockCheckView };
}

export const runStockCheckRequest = () => send("run");
export const continueStockCheckRequest = () => send("continue");

export function stockCheckMessage(error: unknown): string {
  const reason = error instanceof StockCheckRefused ? error.reason : "failed";
  switch (reason) {
    case "supplier_timeout":
      return "The supplier portal did not answer in time.";
    case "supply_shortfall":
      return "The supplier cannot cover the drafted order.";
    case "over_limit":
      return "The order is over the spend limit and needs a new approval.";
    case "stock_check_incomplete":
      return "The check has not finished yet.";
    case "sourcing_required":
      return "Sourcing must be approved first.";
    case "proposal_rejected":
      return "The proposal was rejected. Reset the demo to start again.";
    case "sent_back":
      return "The listing was sent back. Reset the demo to start again.";
    case "already_launched":
      return "The listing is already approved.";
    case "reset_during_request":
      return "The demo was reset while this was in flight, so nothing was recorded. Reload and start again.";
    case "store_unavailable":
      return "The demo store is unavailable. Try again.";
    default:
      return "Could not run the stock check. Try again.";
  }
}
