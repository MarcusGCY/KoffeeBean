import { NextResponse } from "next/server";
import { approveLaunch, approveSourcing, sendBackLaunch, type ApprovalRefusal } from "@/lib/demo/approval";
import { guardDemoWrite } from "@/lib/demo/guard";
import { loadScenario } from "@/lib/demo/scenario";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

const REFUSAL_STATUS: Record<ApprovalRefusal, number> = {
  unknown_approver: 400,
  confirmation_required: 400,
  wrong_approver: 403,
  same_person: 403,
  already_approved: 409,
  proposal_rejected: 409,
  sourcing_required: 409,
  stock_check_required: 409,
  sent_back: 409,
};

const ACTIONS = ["approve_sourcing", "approve_launch", "send_back"] as const;
type Action = (typeof ACTIONS)[number];

function parseAction(value: unknown): Action | null {
  return (ACTIONS as readonly unknown[]).includes(value) ? (value as Action) : null;
}

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let body: { action?: unknown; approverId?: unknown; confirmed?: unknown } | null;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = null;
  }
  const action = parseAction(body?.action);
  if (!action || typeof body?.approverId !== "string") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400, headers: NO_STORE });
  }
  const approverId = body.approverId;
  const confirmed = body.confirmed === true;

  try {
    const scenario = loadScenario();
    const result =
      action === "approve_sourcing"
        ? await approveSourcing(scenario, { approverId, confirmed })
        : action === "approve_launch"
          ? await approveLaunch(scenario, { approverId, confirmed })
          : await sendBackLaunch(scenario, { approverId });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: REFUSAL_STATUS[result.reason], headers: NO_STORE });
    }
    return NextResponse.json({ isDemo: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] approval action failed", error);
    return NextResponse.json({ error: "approval_failed" }, { status: 500 });
  }
}
