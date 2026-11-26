import { z } from "zod";
import { requireBiSecret, requireBiSql } from "@/lib/bi-read";
import { demoEnabled, notFoundResponse } from "@/lib/demo/guard";
import { acceptBiSignal, normaliseConfidence } from "@/lib/yuu/signal";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";

/**
 * Files the Pelita product proposal for approval 1. This is the only route that
 * turns a yuu signal into that approval. The escalation webhook does not.
 */
const bodySchema = z.strictObject({
  sku: z.string().regex(/^PL-\d{5}$/),
  rationale: z.string().trim().min(8).max(400),
  confidence: z.number().finite(),
  windowMinutes: z.number().int().optional(),
});

export async function POST(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  if (!demoEnabled()) return notFoundResponse();
  const sql = requireBiSql();
  if (sql instanceof Response) return sql;
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return yuuJson({ error: "invalid_body" }, 400);
  }
  const confidence = normaliseConfidence(parsed.confidence);
  if (confidence == null) return yuuJson({ error: "invalid_body" }, 400);
  const rationale = parsed.rationale.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (rationale.length < 8) return yuuJson({ error: "invalid_body" }, 400);
  try {
    const result = await acceptBiSignal({
      sku: parsed.sku,
      rationale,
      confidence,
      windowMinutes: parsed.windowMinutes,
    });
    if (!result.ok) return yuuJson({ error: "signal_not_actionable", reason: result.reason }, result.http);
    return yuuJson({
      ok: true,
      idempotent: result.idempotent,
      proposalRef: result.proposalRef,
      proposalStatus: result.proposalStatus,
      signal: result.signal,
    });
  } catch (error) {
    return yuuFailure(error, "[yuu] signal failed");
  }
}
