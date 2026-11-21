import { listUsersAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import type { BiSql } from "./bi-db";
import { hashShopperId } from "./bi-hash";
import { setBiConsent } from "./marketing-sync";

/**
 * Retention for the personalization data this app owns. The figure is pending the privacy owner; change
 * `RETENTION_MONTHS_DEFAULT` or set `PRIVACY_RETENTION_MONTHS` once it is decided. Nothing here runs on its
 * own: `/api/privacy/purge` does the work when a scheduler (or an operator) calls it.
 */
export const RETENTION_MONTHS_DEFAULT = 24;
export const RETENTION_MONTHS_MIN = 1;
export const RETENTION_MONTHS_MAX = 120;

/** The configured period in months. A missing, non-integer or out-of-range value falls back to the default. */
export function retentionMonths(raw: string | undefined = process.env.PRIVACY_RETENTION_MONTHS): number {
  const text = (raw ?? "").trim();
  if (!/^\d{1,4}$/.test(text)) return RETENTION_MONTHS_DEFAULT;
  const months = Number(text);
  return months >= RETENTION_MONTHS_MIN && months <= RETENTION_MONTHS_MAX ? months : RETENTION_MONTHS_DEFAULT;
}

export function retentionCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/** The profile data keys a purge removes from `app_metadata`. Orders, cart and the audit trail are not touched. */
export const PURGED_KEYS = ["barista_profile", "location", "marketing_consent"] as const;

function timeOf(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * The latest sign of use: an order, or a change to any profile item. Data whose age cannot be read counts
 * as old, so a malformed value does not stay forever.
 */
export function lastActivity(meta: Record<string, unknown>): number {
  const orders = Array.isArray(meta.orders) ? meta.orders : [];
  return Math.max(
    0,
    ...orders.map((order) => timeOf(field(order, "createdAt"))),
    timeOf(field(meta.barista_profile, "updatedAt")),
    timeOf(field(meta.location, "consentAt")),
    timeOf(field(meta.marketing_consent, "consentAt")),
  );
}

/** The keys to remove for this user, or none when there is nothing to purge or the user was active since `cutoff`. */
export function keysToPurge(meta: Record<string, unknown>, cutoff: Date): string[] {
  const present = PURGED_KEYS.filter((key) => meta[key] !== undefined && meta[key] !== null);
  if (present.length === 0) return [];
  return lastActivity(meta) < cutoff.getTime() ? [...present] : [];
}

export type PurgeSummary = {
  dryRun: boolean;
  retentionMonths: number;
  cutoff: string;
  bi: { rows: number };
  auth0: { scanned: number; complete: boolean; users: number; failed: number };
};

/**
 * Deletes `bi_customer_profiles` rows not updated since the cutoff, and removes the profile data from
 * Auth0 users with no activity since then. With `dryRun` it only counts. Counts only, no identifiers.
 */
export async function purgeProfiles(
  sql: BiSql,
  options: { now?: Date; months?: number; dryRun?: boolean } = {},
): Promise<PurgeSummary> {
  const now = options.now ?? new Date();
  const months = options.months ?? retentionMonths();
  const dryRun = options.dryRun === true;
  const cutoff = retentionCutoff(now, months);

  const biRows = dryRun
    ? ((await sql.query("SELECT COUNT(*)::int AS n FROM bi_customer_profiles WHERE updated_at < $1::timestamptz", [cutoff.toISOString()])) as { n?: unknown }[])
    : ((await sql.query("DELETE FROM bi_customer_profiles WHERE updated_at < $1::timestamptz RETURNING shopper_hash", [cutoff.toISOString()])) as unknown[]);
  const biCount = dryRun ? Number((biRows[0] as { n?: unknown } | undefined)?.n ?? 0) : biRows.length;

  const { users, complete } = await listUsersAppMetadata();
  const summary: PurgeSummary = {
    dryRun,
    retentionMonths: months,
    cutoff: cutoff.toISOString(),
    bi: { rows: biCount },
    auth0: { scanned: users.length, complete, users: 0, failed: 0 },
  };
  for (const user of users) {
    const keys = keysToPurge(user.appMetadata, cutoff);
    if (keys.length === 0) continue;
    summary.auth0.users += 1;
    if (dryRun) continue;
    try {
      await patchAppMetadata(user.userId, Object.fromEntries(keys.map((key) => [key, null])));
      if (keys.includes("marketing_consent")) await setBiConsent(sql, hashShopperId(user.userId), { consent: false, at: null });
    } catch {
      summary.auth0.failed += 1;
    }
  }
  return summary;
}
