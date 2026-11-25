import { createHmac } from "node:crypto";
import { safeEqual } from "../github-signature";

/** Cookie that carries the signed presenter token after a link is opened. */
export const PRESENTER_COOKIE = "kb_demo_pelita";

/** Default lifetime of a presenter link. */
export const PRESENTER_TTL_MS = 12 * 60 * 60 * 1000;

const MAX_TOKEN_LENGTH = 200;
const DOMAIN = "kb-demo-pelita-presenter:v1";

function mac(secret: string, exp: number): string {
  return createHmac("sha256", secret).update(`${DOMAIN}:${exp}`).digest("hex");
}

/** Signing key for presenter links. Empty when APPROVAL_SECRET is not set. */
export function presenterSecret(): string {
  return process.env.APPROVAL_SECRET?.trim() ?? "";
}

/** `<expiry ms>.<hex hmac-sha256>`. The secret never appears in the token. */
export function signPresenterToken(secret: string, now = Date.now(), ttlMs = PRESENTER_TTL_MS): string {
  if (!secret) throw new Error("Missing signing secret");
  const exp = now + ttlMs;
  return `${exp}.${mac(secret, exp)}`;
}

export function verifyPresenterToken(
  token: string | null | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!token || !secret || token.length > MAX_TOKEN_LENGTH) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expText = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expText) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || exp < now) return false;
  return safeEqual(sig, mac(secret, exp));
}

/** The enter route that turns a link into a cookie. */
export function presenterLink(baseUrl: string, secret: string, now = Date.now(), ttlMs = PRESENTER_TTL_MS): string {
  const url = new URL("/demo/pelita/enter", baseUrl);
  url.searchParams.set("k", signPresenterToken(secret, now, ttlMs));
  return url.toString();
}

export function tokenExpiry(token: string): number {
  return Number(token.slice(0, token.indexOf(".")));
}
