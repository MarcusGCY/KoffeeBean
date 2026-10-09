import { createHmac } from "node:crypto";
import { env } from "./env";
import { safeEqual } from "./github-signature";
import { appOrigin } from "./origin";

/** Signed merge links stay valid for 48 hours. */
export const MERGE_LINK_TTL_MS = 48 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", env("APPROVAL_SECRET")).update(payload).digest("hex");
}

function readGrant(token: string): { exp: number; sig: string } | undefined {
  const trimmed = token.trim();
  if (trimmed.length > 200) return undefined;
  const dot = trimmed.indexOf(".");
  if (dot <= 0) return undefined;
  const exp = Number(trimmed.slice(0, dot));
  const sig = trimmed.slice(dot + 1);
  if (!Number.isInteger(exp) || exp <= 0) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return undefined;
  return { exp, sig };
}

/** HMAC of `merge:<issue>:<pr>:<exp>` with APPROVAL_SECRET. `exp` is unix milliseconds. */
export function mergeToken(issue: number, pr: number, now = Date.now()): string {
  const exp = now + MERGE_LINK_TTL_MS;
  return `${exp}.${sign(`merge:${issue}:${pr}:${exp}`)}`;
}

export function verifyMergeToken(
  issue: number,
  pr: number,
  token: string,
  now = Date.now(),
): "ok" | "expired" | "invalid" {
  const grant = readGrant(token);
  if (!grant) return "invalid";
  if (!safeEqual(grant.sig, sign(`merge:${issue}:${pr}:${grant.exp}`))) return "invalid";
  if (grant.exp > now + MERGE_LINK_TTL_MS + CLOCK_SKEW_MS) return "invalid";
  if (grant.exp <= now) return "expired";
  return "ok";
}

/** GET URL the Grok bot opens. Same host as approve/reject links. */
export function mergeLink(issue: number, pr: number, now = Date.now()): string {
  const token = mergeToken(issue, pr, now);
  return `${appOrigin()}/api/merge?issue=${issue}&pr=${pr}&token=${token}`;
}

/** Pull number from a github.com pull URL. When `repoFullName` is set, other repos do not match. */
export function prNumberFromUrl(url: string, repoFullName?: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) return undefined;
  if (repoFullName && `${match[1]}/${match[2]}`.toLowerCase() !== repoFullName.toLowerCase()) return undefined;
  const n = Number(match[3]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
