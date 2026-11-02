import { NextResponse } from "next/server";
import { z } from "zod";
import { applyCoupon, clearCoupon } from "@/lib/store-meta";
import { dbFailure, rateLimited, readJson, requireShopper, requireWrite } from "@/lib/store-http";

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
    if ("error" in result) {
      if (result.error === "rate_limited") return rateLimited(result);
      return NextResponse.json({ error: "invalid_coupon" }, { status: 400 });
    }
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
    const result = await clearCoupon(auth.userId);
    if ("error" in result) return rateLimited(result);
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}
