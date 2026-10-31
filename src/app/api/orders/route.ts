import { NextResponse } from "next/server";
import { listOrders, placeOrder } from "@/lib/store-db";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

export async function GET() {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ orders: await listOrders(auth.userId) });
  } catch (err) {
    return dbFailure(err);
  }
}

export async function POST(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;

  try {
    const result = await placeOrder(auth.userId);
    if ("error" in result) return NextResponse.json({ error: "empty_cart" }, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}
