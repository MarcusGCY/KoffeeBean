import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario } from "@/lib/demo/scenario";
import { StaleEpochError } from "@/lib/demo/state";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let action: unknown;
  try {
    action = ((await req.json()) as { action?: unknown } | null)?.action;
  } catch {
    action = undefined;
  }
  if (action !== "reject") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await rejectProposal(loadScenario());
    if (!result.ok) {
      return NextResponse.json({ error: "already_approved" }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ isDemo: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StaleEpochError) {
      return NextResponse.json({ error: "reset_during_request" }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] proposal action failed", error);
    return NextResponse.json({ error: "proposal_failed" }, { status: 500 });
  }
}
