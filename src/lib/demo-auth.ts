import { createHmac } from "node:crypto";
import { env } from "./env";
import { safeEqual } from "./github-signature";

/** How long a signed revert or reset link stays valid. */
export const DEMO_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

const CSRF_TTL_MS = 2 * 60 * 60 * 1000;

/** Claim written by the Post-Login Action. Override with AUTH0_ROLES_CLAIM. */
export const DEFAULT_ROLES_CLAIM = "https://beanbox/roles";

export function rolesClaimName(): string {
  const configured = process.env.AUTH0_ROLES_CLAIM?.trim();
  return configured || DEFAULT_ROLES_CLAIM;
}

/**
 * Role names from the ID token claim. Auth0 sends an array. A single string
 * is one role name, not a comma-separated list.
 */
export function roleNames(value: unknown): string[] {
  if (typeof value === "string") {
    const role = value.trim();
    return role ? [role] : [];
  }
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const role = item.trim();
    if (role) names.push(role);
  }
  return names;
}

/** True when the session user's roles claim contains the Auth0 role `admin`. */
export function hasAdminRole(user: object | null | undefined): boolean {
  if (!user) return false;
  const claim = (user as Record<string, unknown>)[rolesClaimName()];
  return roleNames(claim).includes("admin");
}

/**
 * Demo owner: a signed-in user with an email, an email Auth0 has not marked
 * unverified, and the `admin` role. Callers respond with 404 otherwise.
 */
export function isAdminUser(
  user: object | null | undefined,
): user is { sub: string; email: string } {
  if (!user) return false;
  const record = user as Record<string, unknown>;
  if (typeof record.sub !== "string" || record.sub.length === 0) return false;
  if (typeof record.email !== "string") return false;
  if (record.email_verified === false) return false;
  return hasAdminRole(user);
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
