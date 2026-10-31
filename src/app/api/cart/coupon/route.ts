import { NextResponse } from "next/server";
import { z } from "zod";
import { applyCoupon, clearCoupon } from "@/lib/store-db";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

const Body = z.object({
  code: z.string().trim().min(1).max(40),
});

export async function POST(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = await applyCoupon(auth.userId, parsed.data.code);
    if ("error" in result) return NextResponse.json({ error: "invalid_coupon" }, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;

  try {
    return NextResponse.json(await clearCoupon(auth.userId));
  } catch (err) {
    return dbFailure(err);
  }
}
