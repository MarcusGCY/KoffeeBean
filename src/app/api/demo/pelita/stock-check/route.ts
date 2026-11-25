import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { loadScenario } from "@/lib/demo/scenario";
import { continueFromStockCheck, runStockCheck, type StockCheckRefusal } from "@/lib/demo/stock-check";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

const REFUSAL_STATUS: Record<StockCheckRefusal, number> = {
  sourcing_required: 409,
  proposal_rejected: 409,
  sent_back: 409,
  already_launched: 409,
  stock_check_incomplete: 409,
  over_limit: 409,
  supply_shortfall: 409,
  supplier_timeout: 504,
};

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let action: unknown;
  try {
    action = ((await req.json()) as { action?: unknown } | null)?.action;
  } catch {
    action = undefined;
  }
  if (action !== "run" && action !== "continue") {
    return NextResponse.json({ error: "unknown_action" }, { status: 400, headers: NO_STORE });
  }

  try {
    const scenario = loadScenario();
    const result = action === "run" ? await runStockCheck(scenario) : await continueFromStockCheck(scenario);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: REFUSAL_STATUS[result.reason], headers: NO_STORE });
    }
    return NextResponse.json({ isDemo: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] stock check failed", error);
    return NextResponse.json({ error: "stock_check_failed" }, { status: 500 });
  }
}
