import { NextResponse } from "next/server";
import { proposeReorder } from "@/lib/chat-tools";
import { confirmedCard } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";
import { StoreUnavailableError } from "@/lib/store-error";

export async function POST() {
  const shopper = await getShopper();
  if (!shopper) return NextResponse.json({ error: "Sign in to use support chat." }, { status: 401 });
  const secret = process.env.APPROVAL_SECRET?.trim() ?? "";
  if (!secret) {
    console.error("[chat] unconfigured");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  try {
    const pending = await proposeReorder(shopper.id);
    if ("error" in pending && pending.error) {
      const status = pending.error === "no_orders" ? 404 : 400;
      return NextResponse.json({ error: pending.error }, { status });
    }
    if (!("actionId" in pending) || !pending.actionId) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    const card = confirmedCard(shopper.id, pending.actionId, secret);
    if (!card) return NextResponse.json({ error: "unavailable" }, { status: 503 });
    return NextResponse.json(card);
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      console.error("[chat] store unavailable");
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    console.error("[chat] request failed", err instanceof Error ? err.name : "Error");
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
