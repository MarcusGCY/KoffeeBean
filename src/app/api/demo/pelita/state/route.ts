import { NextResponse } from "next/server";
import { guardDemoApi } from "@/lib/demo/guard";
import { getDemoState } from "@/lib/demo/state";
import { StoreUnavailableError } from "@/lib/store-error";

export async function GET(req: Request) {
  const denied = guardDemoApi(req);
  if (denied) return denied;
  try {
    const state = await getDemoState();
    return NextResponse.json({ isDemo: true, ...state }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[demo:pelita] state read failed", error);
    return NextResponse.json({ error: "state_failed" }, { status: 500 });
  }
}
