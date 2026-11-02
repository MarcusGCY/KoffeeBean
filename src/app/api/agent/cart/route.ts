import { NextResponse } from "next/server";
import { agentUserId } from "@/lib/agent-auth";
import { getCart, recordAudit } from "@/lib/store-meta";
import { dbFailure } from "@/lib/store-http";

export async function GET(req: Request) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const cart = await getCart(userId);
    await recordAudit(userId, {
      ts: new Date().toISOString(),
      tool: "view_cart",
      summary: `${cart.items.length} cart lines`,
      outcome: "ok",
    });
    return NextResponse.json({
      items: cart.items,
      subtotalCents: cart.subtotalCents,
      discountCents: cart.discountCents,
      taxCents: cart.taxCents,
      totalCents: cart.totalCents,
      discountApplied: cart.discountCents > 0,
    });
  } catch (err) {
    return dbFailure(err);
  }
}
