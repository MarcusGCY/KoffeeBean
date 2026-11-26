import { requireBiSecret } from "@/lib/bi-read";
import { yuuWindowMinutes, YuuQueryError } from "@/lib/yuu/db";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";
import {
  parseBucketDays,
  parseTxnLimit,
  readYuuTransactionBuckets,
  readYuuTransactions,
  transactionWindow,
} from "@/lib/yuu/transactions";

export const maxDuration = 30;

/**
 * Transaction-level yuu rows for BI monitoring. The aggregate report stays on GET /api/bi/loyalty.
 * Filing a Pelita proposal is POST /api/bi/loyalty/signal, not this route.
 */
export async function GET(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const now = new Date();
  try {
    const bucket = params.get("bucket");
    if (bucket != null && bucket.trim() !== "") {
      if (bucket.trim() !== "hour") return yuuJson({ error: "invalid_body" }, 400);
      const days = parseBucketDays(params.get("days"));
      return yuuJson(await readYuuTransactionBuckets({ now, days }));
    }
    if (params.get("days") != null && params.get("days")?.trim() !== "") {
      return yuuJson({ error: "invalid_body" }, 400);
    }
    const rawWindow = params.get("window_minutes");
    const windowMinutes = rawWindow == null || rawWindow.trim() === "" ? undefined : yuuWindowMinutes(Number(rawWindow));
    const range = transactionWindow(params, now, windowMinutes);
    const limit = parseTxnLimit(params.get("limit"));
    return yuuJson(await readYuuTransactions({ now, ...range, limit }));
  } catch (error) {
    if (error instanceof YuuQueryError) return yuuJson({ error: "invalid_body" }, 400);
    return yuuFailure(error, "[yuu] transactions read failed");
  }
}
