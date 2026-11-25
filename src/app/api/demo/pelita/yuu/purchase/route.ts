import { z } from "zod";
import { guardDemoWrite } from "@/lib/demo/guard";
import { getShopper } from "@/lib/shopper";
import { purchaseYuu, YuuQueryError } from "@/lib/yuu/db";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";

export const maxDuration = 30;

const bodySchema = z.strictObject({
  sku: z.string().regex(/^PL-\d{5}$/),
  qty: z.number().int().min(1).max(20).optional(),
  memberId: z.string().regex(/^sim-[a-z0-9-]{1,48}$/).optional(),
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
  let shopper: { id: string; name?: string } | null = null;
  try {
    const current = await getShopper();
    if (current?.id) shopper = { id: current.id, name: current.name };
  } catch {
    shopper = null;
  }
  try {
    const result = await purchaseYuu({
      sku: parsed.sku,
      qty: parsed.qty ?? 1,
      memberId: shopper ? null : (parsed.memberId ?? null),
      shopper,
      channel: "web",
    });
    return yuuJson({ isDemo: true, ...result });
  } catch (error) {
    if (error instanceof YuuQueryError && (error.message === "unknown_sku" || error.message === "unknown_member" || error.message === "invalid_qty")) {
      return yuuJson({ error: error.message }, 400);
    }
    return yuuFailure(error, "[yuu] purchase failed");
  }
}
