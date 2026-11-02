import { createHmac } from "node:crypto";
import { safeEqual } from "./github-signature";

/** Loopback session tokens last five minutes. The in-process agent checks `exp` and `typ`. */
export const SUPPORT_TOKEN_TTL_SEC = 300;

type Claims = { typ: "support"; sub: string; exp: number };

/**
 * HMAC token carrying the shopper id. `userId` is taken from the server session
 * when the Next app mints it, and from the verified claims everywhere else.
 * `typ` is required so a confirm action id cannot be used as this bearer token.
 */
export function signSupportToken(userId: string, secret: string, nowMs = Date.now()): string {
  const sub = userId.trim();
  if (!sub || !secret) throw new Error("support_token");
  const claims: Claims = { typ: "support", sub, exp: Math.floor(nowMs / 1000) + SUPPORT_TOKEN_TTL_SEC };
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
    if (claims.typ !== "support") return null;
    if (typeof claims.sub !== "string" || !claims.sub.trim()) return null;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return { userId: claims.sub };
  } catch {
    return null;
  }
}
