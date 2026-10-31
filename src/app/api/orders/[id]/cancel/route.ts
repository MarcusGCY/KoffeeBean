import { NextResponse } from "next/server";
import { cancelOrder } from "@/lib/store-db";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const { id } = await context.params;

  try {
    const result = await cancelOrder(auth.userId, id);
    if ("error" in result && result.error === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if ("error" in result) return NextResponse.json({ error: "not_cancellable" }, { status: 409 });
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}
