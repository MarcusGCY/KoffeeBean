import { NextResponse } from "next/server";
import { z } from "zod";
import { biId, emitBi, trackProductViewed } from "@/lib/bi-track";
import { getProduct } from "@/lib/cart";
import { getShopper } from "@/lib/shopper";
import { takeProductViewSlot } from "@/lib/store-meta";
import { dbFailure, rateLimited, readJson, requireWrite } from "@/lib/store-http";

const Body = z.object({ productId: z.string().trim().min(1).max(80) }).strip();

/**
 * Fire-and-forget `product.viewed` beacon. 204 for a valid view; BI failures never surface.
 * Each known product view takes a `productViews` slot from the shopper's `chat_limits`
 * (same limiter and 429 shape as the cart routes).
 */
export async function POST(req: Request) {
  const shopper = await getShopper().catch(() => null);
  if (!shopper) return NextResponse.json({ error: "Sign in to shop." }, { status: 401 });
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const productId = biId(parsed.data.productId);
  if (productId && getProduct(productId)) {
    try {
      const slot = await takeProductViewSlot(shopper.id);
      if ("error" in slot) return rateLimited(slot);
      const ctx = slot.isTest ? { sub: shopper.id, isTest: true } : { sub: shopper.id };
      emitBi(() => trackProductViewed(ctx, { productId }));
    } catch (err) {
      return dbFailure(err);
    }
  }
  return new NextResponse(null, { status: 204 });
}
