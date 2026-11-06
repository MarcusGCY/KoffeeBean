import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type BiSql = NeonQueryFunction<false, false>;

let cached: { url: string; sql: BiSql } | null = null;

function databaseUrl(): string {
  return (process.env.DATABASE_URL ?? "").trim();
}

/** True when a Neon connection string is set. Without it BI writes are skipped. */
export function biDbConfigured(): boolean {
  return databaseUrl() !== "";
}

/**
 * Neon HTTP query function for the BI event log, or null when `DATABASE_URL` is
 * unset so local dev and demos without Neon still boot. Neon holds analytics only;
 * carts and orders stay in Auth0 and chat quotas stay in Upstash.
 */
export function getBiSql(): BiSql | null {
  const url = databaseUrl();
  if (!url) return null;
  if (cached?.url !== url) cached = { url, sql: neon(url) };
  return cached.sql;
}
