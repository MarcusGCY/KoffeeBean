import { createHmac } from "node:crypto";
import { env } from "./env";
import { safeEqual } from "./github-signature";

/** How long a signed revert or reset link stays valid. */
export const DEMO_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

const CSRF_TTL_MS = 2 * 60 * 60 * 1000;

export function adminEmailAllowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/** Case-insensitive match against ADMIN_EMAILS. Empty allowlist matches nobody. */
export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return adminEmailAllowlist().includes(normalized);
}

function sign(payload: string): string {
  return createHmac("sha256", env("APPROVAL_SECRET")).update(payload).digest("hex");
}

function readGrant(token: string, now: number): { exp: number; sig: string } | undefined {
  if (token.length > 200) return undefined;
  const dot = token.indexOf(".");
  if (dot <= 0) return undefined;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isInteger(exp) || exp < now) return undefined;
  if (!/^[0-9a-f]+$/i.test(sig)) return undefined;
  return { exp, sig };
}

export function demoCsrfToken(userId: string, now = Date.now()): string {
  const exp = now + CSRF_TTL_MS;
  return `${exp}.${sign(`demo-csrf:${userId}:${exp}`)}`;
}

export function verifyDemoCsrf(userId: string, token: string, now = Date.now()): boolean {
  const grant = readGrant(token, now);
  if (!grant) return false;
  return safeEqual(grant.sig, sign(`demo-csrf:${userId}:${grant.exp}`));
}

/** Signed POST grant for one pull request. Same secret as approve/reject links. */
export function revertGrant(pr: number, now = Date.now()): string {
  const exp = now + DEMO_GRANT_TTL_MS;
  return `${exp}.${sign(`revert:${pr}:${exp}`)}`;
}

export function verifyRevertGrant(pr: number, token: string, now = Date.now()): boolean {
  const grant = readGrant(token, now);
  if (!grant) return false;
  return safeEqual(grant.sig, sign(`revert:${pr}:${grant.exp}`));
}

export function resetGrant(now = Date.now()): string {
  const exp = now + DEMO_GRANT_TTL_MS;
  return `${exp}.${sign(`reset-demo:${exp}`)}`;
}

export function verifyResetGrant(token: string, now = Date.now()): boolean {
  const grant = readGrant(token, now);
  if (!grant) return false;
  return safeEqual(grant.sig, sign(`reset-demo:${grant.exp}`));
}

/**
 * Browser CSRF check. Compares the Origin or Referer host to the host the
 * request actually arrived on, including the forwarded host Vercel sets.
 * A signed bot grant does not use this; the HMAC is the authorization.
 */
export function isSameOrigin(req: Request): boolean {
  const source = req.headers.get("origin") || req.headers.get("referer");
  if (!source) return false;
  let sourceHost: string;
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }
  if (!sourceHost) return false;
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwarded || req.headers.get("host") || "";
  if (host && sourceHost === host) return true;
  try {
    return new URL(req.url).host === sourceHost;
  } catch {
    return false;
  }
}
