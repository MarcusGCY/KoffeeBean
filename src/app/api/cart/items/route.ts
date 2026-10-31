import { NextResponse } from "next/server";
import { z } from "zod";
import { addToCart, removeFromCart } from "@/lib/store-db";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

const Body = z
  .object({
    productId: z.string().trim().min(1).max(80),
    qty: z.number().int().min(1).max(99).optional(),
  })
  .strip();

async function change(req: Request, op: "add" | "remove") {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const qty = parsed.data.qty ?? 1;
  try {
    const result =
      op === "add"
        ? await addToCart(auth.userId, parsed.data.productId, qty)
        : await removeFromCart(auth.userId, parsed.data.productId, qty);
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
  } catch (err) {
    return dbFailure(err);
  }
}

export function POST(req: Request) {
  return change(req, "add");
}

export function DELETE(req: Request) {
  return change(req, "remove");
}
