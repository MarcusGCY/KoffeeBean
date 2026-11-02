import { NextResponse } from "next/server";
import { agentUserId } from "@/lib/agent-auth";
import { getOrder, recordAudit } from "@/lib/store-meta";
import { dbFailure } from "@/lib/store-http";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const order = await getOrder(userId, id);
    await recordAudit(userId, {
      ts: new Date().toISOString(),
      tool: "get_order_status",
      summary: order ? `${order.id} ${order.status}` : "Order was not found",
      outcome: order ? "ok" : "not_found",
    });
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({
      id: order.id,
      createdAt: order.createdAt,
      status: order.status,
      cancellable: order.cancellable,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      items: order.items,
    });
  } catch (err) {
    return dbFailure(err);
  }
}
