import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Keep this in step with `src/lib/support-token.ts`.
 * The deployed agent only ships the `support-agent/` folder, so it cannot import the Next app.
 */

const TTL_SEC = 300;

type Claims = { sub: string; exp: number };

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function signSupportToken(userId: string, secret: string, nowMs = Date.now()): string {
  const sub = userId.trim();
  if (!sub || !secret) throw new Error("support_token");
  const claims: Claims = { sub, exp: Math.floor(nowMs / 1000) + TTL_SEC };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySupportToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): { userId: string } | null {
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Claims>;
    if (typeof claims.sub !== "string" || !claims.sub.trim()) return null;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return { userId: claims.sub };
  } catch {
    return null;
  }
}
