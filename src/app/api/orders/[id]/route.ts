import { NextResponse } from "next/server";
import { getOrder } from "@/lib/store-db";
import { dbFailure, requireShopper } from "@/lib/store-http";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const { id } = await context.params;
  try {
    const order = await getOrder(auth.userId, id);
    if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(order);
  } catch (err) {
    return dbFailure(err);
  }
}
