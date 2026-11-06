import { createHmac } from "node:crypto";

const MIN_SECRET_LENGTH = 16;

export class BiHashConfigError extends Error {
  constructor() {
    super("bi_hash_unconfigured");
    this.name = "BiHashConfigError";
  }
}

export function biHashConfigured(): boolean {
  return (process.env.BI_HASH_SECRET ?? "").trim().length >= MIN_SECRET_LENGTH;
}

/**
 * Stable, non-reversible shopper id for BI. HMAC-SHA256 of the Auth0 `sub`,
 * keyed by `BI_HASH_SECRET`, as 64 lowercase hex characters. The same `sub` always
 * gives the same hash while the secret is unchanged, so events join per shopper
 * without storing the `sub`. A plain unkeyed hash is not used: Auth0 subs are
 * guessable (`auth0|<24 hex>`), so a keyed hash is what stops a leaked table from
 * being matched back to accounts. Rotating the secret breaks joins with old rows.
 */
export function hashShopperId(sub: string): string {
  const secret = (process.env.BI_HASH_SECRET ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new BiHashConfigError();
  const id = sub.trim();
  if (!id) throw new Error("bi_hash_empty_sub");
  return createHmac("sha256", secret).update(id).digest("hex");
}
