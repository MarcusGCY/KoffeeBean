import { NextResponse } from "next/server";
import { guardDemoWrite } from "@/lib/demo/guard";
import { StaleEpochError, getDemoSnapshot, setElapsedMode } from "@/lib/demo/state";
import { StoreUnavailableError } from "@/lib/store-error";

const NO_STORE = { "cache-control": "private, no-store" };

/** The presenter's choice of where the screen 06 and 07 elapsed time comes from. Presenter-only, like every demo write. */
export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;

  let mode: unknown;
  try {
    mode = ((await req.json()) as { mode?: unknown } | null)?.mode;
  } catch {
    mode = undefined;
  }
  if (mode !== "fixture" && mode !== "real") {
    return NextResponse.json({ error: "unknown_mode" }, { status: 400, headers: NO_STORE });
  }

  try {
    const { epoch } = await getDemoSnapshot();
    await setElapsedMode(mode, epoch);
    return NextResponse.json({ isDemo: true, elapsedMode: mode }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StaleEpochError) {
      return NextResponse.json({ error: "reset_during_request" }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503, headers: NO_STORE });
    }
    console.error("[demo:pelita] elapsed mode failed", error);
    return NextResponse.json({ error: "elapsed_failed" }, { status: 500, headers: NO_STORE });
  }
}
