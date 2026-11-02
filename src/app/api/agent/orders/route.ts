import { NextResponse } from "next/server";
import { agentUserId } from "@/lib/agent-auth";
import { listOrders, recordAudit } from "@/lib/store-meta";
import { dbFailure } from "@/lib/store-http";

export async function GET(req: Request) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const orders = await listOrders(userId);
    await recordAudit(userId, {
      ts: new Date().toISOString(),
      tool: "list_my_orders",
      summary: `${orders.length} orders`,
      outcome: "ok",
    });
    return NextResponse.json({
      orders: orders.map((order) => ({
        id: order.id,
        createdAt: order.createdAt,
        status: order.status,
        cancellable: order.cancellable,
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
      })),
    });
  } catch (err) {
    return dbFailure(err);
  }
}
