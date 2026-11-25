import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { resetDemo } from "@/lib/demo/state";
import { resetYuuLoyalty } from "@/lib/yuu/reset";
import { StoreUnavailableError } from "@/lib/store-error";

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;
  try {
    // Loyalty first, then the demo stage. A missing yuu table (migration not applied yet)
    // does not block the existing reset. Any other loyalty failure stops before the stage moves.
    await resetYuuLoyalty();
    const state = await resetDemo();
    return NextResponse.json({ isDemo: true, ...state }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] reset failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "reset_failed" }, { status: 500 });
  }
}
