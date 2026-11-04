import { NextResponse } from "next/server";
import { usualFor } from "@/lib/chat-tools";
import { getShopper } from "@/lib/shopper";
import { StoreUnavailableError } from "@/lib/store-error";

export async function GET() {
  const shopper = await getShopper();
  if (!shopper) return NextResponse.json({ usual: null }, { status: 401 });
  try {
    const usual = await usualFor(shopper.id);
    return NextResponse.json({ usual });
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      console.error("[chat] store unavailable");
      return NextResponse.json({ usual: null }, { status: 503 });
    }
    console.error("[chat] request failed", err instanceof Error ? err.name : "Error");
    return NextResponse.json({ usual: null }, { status: 502 });
  }
}
