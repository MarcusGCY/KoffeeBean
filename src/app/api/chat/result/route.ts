import { NextResponse } from "next/server";
import { getShopper } from "@/lib/shopper";
import { StoreUnavailableError } from "@/lib/store-error";
import { readChatTurn } from "@/lib/upstash";

const TURN_ID = /^[a-f0-9]{32}$/;

export async function GET(req: Request) {
  const shopper = await getShopper();
  if (!shopper) {
    return NextResponse.json({ error: "Sign in to use support chat." }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("id")?.trim() ?? "";
  if (!TURN_ID.test(id)) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 400 });
  }

  try {
    const turn = await readChatTurn(shopper.id, id);
    if (!turn || turn.userId !== shopper.id) {
      return NextResponse.json({ error: "unavailable" }, { status: 404 });
    }
    if (turn.status === "pending") return NextResponse.json({ status: "pending" });
    if (turn.status === "ready" && turn.reply) {
      return NextResponse.json({
        status: "ready",
        reply: turn.reply,
        ...(turn.pendingAction ? { pendingAction: turn.pendingAction } : {}),
      });
    }
    return NextResponse.json({
      status: "error",
      error: turn.error ?? "unavailable",
      httpStatus: turn.httpStatus ?? 502,
    });
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      console.error("[chat] store unavailable");
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    console.error("[chat] result failed", err instanceof Error ? err.name : "Error");
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
