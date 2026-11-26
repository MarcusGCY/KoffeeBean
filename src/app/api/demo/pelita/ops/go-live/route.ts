import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { isLaunchSku, launchWriteResult } from "@/lib/demo/launch";
import { goLiveNow } from "@/lib/demo/launch-store";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

/** Presenter action: publish one configured sku immediately. The BI secret is not used here. */
export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let sku: unknown;
  try {
    sku = ((await req.json()) as { sku?: unknown } | null)?.sku;
  } catch {
    sku = undefined;
  }
  if (typeof sku !== "string" || !isLaunchSku(sku.trim())) {
    return NextResponse.json({ error: "invalid_sku" }, { status: 400, headers: NO_STORE });
  }

  try {
    const config = await goLiveNow(sku.trim());
    if (!config) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return NextResponse.json(launchWriteResult(config), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: NO_STORE });
    }
    console.error("[demo:pelita] go live failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "go_live_failed" }, { status: 500, headers: NO_STORE });
  }
}
