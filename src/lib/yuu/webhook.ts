import { createHmac } from "node:crypto";
import { appOrigin } from "@/lib/origin";
import { YUU_LABEL } from "./types";

/** How long a webhook POST may run before it is abandoned. */
export const YUU_WEBHOOK_TIMEOUT_MS = 3_000;

export type YuuStoreQty = { store_id: string; qty: number };

/** One escalation burst. `signalId` is the webhook dedupe key for this detection window. */
export type YuuEscalationNotice = {
  signalId: string;
  sku: string;
  productName: string;
  score: number;
  repeatMembers: number;
  distinctMembers: number;
  qty: number;
  windowMinutes: number;
  minRepeatMembers: number;
  minScore: number;
  stores: YuuStoreQty[];
  scanComplete: boolean;
  detectedAt: string;
};

export function yuuWebhookUrl(): string | null {
  const raw = (process.env.YUU_SIGNAL_WEBHOOK_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function yuuWebhookSecret(): string {
  return (process.env.YUU_SIGNAL_WEBHOOK_SECRET ?? "").trim();
}

function publicOrigin(): string {
  try {
    return appOrigin().replace(/\/$/, "");
  } catch {
    return "https://koffee-bean.vercel.app";
  }
}

/** Raw JSON body. No member ids, names, or emails. `signal_id` is the dedupe key. */
export function escalationBody(notice: YuuEscalationNotice): string {
  const origin = publicOrigin();
  return JSON.stringify({
    type: "yuu.signal.escalated",
    label: YUU_LABEL,
    signal_id: notice.signalId,
    sku: notice.sku,
    product_name: notice.productName,
    score: notice.score,
    repeat_members: notice.repeatMembers,
    distinct_members: notice.distinctMembers,
    qty: notice.qty,
    window_minutes: notice.windowMinutes,
    thresholds: {
      min_repeat_members: notice.minRepeatMembers,
      min_score: notice.minScore,
    },
    stores: notice.stores,
    scan_complete: notice.scanComplete,
    detected_at: notice.detectedAt,
    links: {
      ops: `${origin}/pelita/ops`,
      loyalty_api: `${origin}/api/bi/loyalty`,
    },
  });
}

/**
 * HMAC-SHA256 of the raw body, `sha256=<hex>`.
 * Sent as `X-Hub-Signature-256` (what the receiver checks) and `X-Yuu-Signature`.
 */
export function yuuWebhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export type WebhookPostResult =
  | { configured: false }
  | { configured: true; ok: boolean; status: number | null };

/**
 * POSTs the raw body. Logs a status code, "timeout", or "error" only.
 * The URL, the body, and the secret are never logged.
 */
export async function postEscalation(body: string): Promise<WebhookPostResult> {
  const url = yuuWebhookUrl();
  if (!url) return { configured: false };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = yuuWebhookSecret();
  if (secret) {
    const signature = yuuWebhookSignature(body, secret);
    headers.authorization = `Bearer ${secret}`;
    headers["x-hub-signature-256"] = signature;
    headers["x-yuu-signature"] = signature;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(YUU_WEBHOOK_TIMEOUT_MS),
    });
    console.error("[yuu] webhook", response.status);
    return { configured: true, ok: response.ok, status: response.status };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    console.error("[yuu] webhook", name === "TimeoutError" || name === "AbortError" ? "timeout" : "error");
    return { configured: true, ok: false, status: null };
  }
}
