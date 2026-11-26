import { z } from "zod";
import { guardDemoWrite } from "@/lib/demo/guard";
import { getShopper } from "@/lib/shopper";
import { purchaseYuu, YuuQueryError } from "@/lib/yuu/db";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";

export const maxDuration = 30;

const bodySchema = z.strictObject({
  sku: z.string().regex(/^PL-\d{5}$/),
  qty: z.number().int().min(1).max(20).optional(),
  channel: z.enum(["web", "partner"]).optional(),
  storeId: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
});

export async function POST(req: Request) {
  const denied = guardDemoWrite(req);
  if (denied) return denied;
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return yuuJson({ error: "invalid_body" }, 400);
  }
  let shopperId: string | null = null;
  try {
    const current = await getShopper();
    if (current?.id) shopperId = current.id;
  } catch {
    shopperId = null;
  }
  if (!shopperId) return yuuJson({ error: "sign_in_required" }, 401);
  try {
    const result = await purchaseYuu({
      sku: parsed.sku,
      qty: parsed.qty ?? 1,
      channel: parsed.channel,
      storeId: parsed.storeId,
      shopperId,
    });
    return yuuJson({ isDemo: true, ...result });
  } catch (error) {
    if (error instanceof YuuQueryError && (error.message === "unknown_sku" || error.message === "invalid_qty" || error.message === "unknown_store")) {
      return yuuJson({ error: error.message }, 400);
    }
    if (error instanceof YuuQueryError && error.message === "metadata_full") {
      return yuuJson({ error: "metadata_full" }, 409);
    }
    return yuuFailure(error, "[yuu] purchase failed");
  }
}
