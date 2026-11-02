import { NextResponse } from "next/server";
import products from "@/data/products.json";
import { agentUserId } from "@/lib/agent-auth";
import { recordAudit } from "@/lib/store-meta";
import { dbFailure } from "@/lib/store-http";

export async function GET(req: Request) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await recordAudit(userId, {
      ts: new Date().toISOString(),
      tool: "list_products",
      summary: `Returned ${products.length} products`,
      outcome: "ok",
    });
    return NextResponse.json({ products });
  } catch (err) {
    return dbFailure(err);
  }
}
