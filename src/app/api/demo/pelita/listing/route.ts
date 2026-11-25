import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { editListing, runListingDraft, sendForApproval, type ListingRefusal } from "@/lib/demo/listing";
import { loadScenario } from "@/lib/demo/scenario";
import { StaleEpochError } from "@/lib/demo/state";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

const REFUSAL_STATUS: Record<ListingRefusal, number> = {
  unknown_approver: 400,
  invalid_description: 400,
  claim_not_allowed: 422,
  sourcing_required: 409,
  proposal_rejected: 409,
  sent_back: 409,
  already_launched: 409,
  stock_check_required: 409,
  draft_required: 409,
  already_sent: 409,
  claims_failed: 502,
};

const ACTIONS = ["draft", "edit", "send"] as const;
type Action = (typeof ACTIONS)[number];

function parseAction(value: unknown): Action | null {
  return (ACTIONS as readonly unknown[]).includes(value) ? (value as Action) : null;
}

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let body: { action?: unknown; approverId?: unknown; description?: unknown } | null;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = null;
  }
  const action = parseAction(body?.action);
  const approverId = body?.approverId;
  if (!action || (action !== "draft" && typeof approverId !== "string")) {
    return NextResponse.json({ error: "unknown_action" }, { status: 400, headers: NO_STORE });
  }
  if (action === "edit" && typeof body?.description !== "string") {
    return NextResponse.json({ error: "invalid_description" }, { status: 400, headers: NO_STORE });
  }

  try {
    const scenario = loadScenario();
    const result =
      action === "draft"
        ? await runListingDraft(scenario)
        : action === "edit"
          ? await editListing(scenario, { approverId: approverId as string, description: body?.description as string })
          : await sendForApproval(scenario, { approverId: approverId as string });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: REFUSAL_STATUS[result.reason], headers: NO_STORE });
    }
    return NextResponse.json({ isDemo: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StaleEpochError) {
      return NextResponse.json({ error: "reset_during_request" }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] listing action failed", error);
    return NextResponse.json({ error: "listing_failed" }, { status: 500 });
  }
}
