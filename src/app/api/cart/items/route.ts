import { NextResponse } from "next/server";
import { z } from "zod";
import { biId, emitBi, trackAdded, trackUndone } from "@/lib/bi-track";
import { getProduct } from "@/lib/cart";
import { addToCart, removeFromCart } from "@/lib/store-meta";
import { dbFailure, rateLimited, readJson, requireShopper, requireWrite } from "@/lib/store-http";

const Body = z
  .object({
    productId: z.string().trim().min(1).max(80),
    qty: z.number().int().min(1).max(99).optional(),
    recommendationId: z.string().optional(),
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
    if ("error" in result) {
      if (result.error === "rate_limited") return rateLimited(result);
      return NextResponse.json(result, { status: 400 });
    }
    const recommendationId = biId(parsed.data.recommendationId);
    if (recommendationId && getProduct(parsed.data.productId)) {
      const productId = parsed.data.productId;
      emitBi(() =>
        op === "add"
          ? trackAdded({ sub: auth.userId }, { recommendationId, productId, qty })
          : trackUndone({ sub: auth.userId }, { recommendationId, productId }),
      );
    }
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
