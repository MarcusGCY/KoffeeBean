import { getAppMetadata, listUsersAppMetadata } from "./auth0-mgmt";
import type { BiSql } from "./bi-db";
import { hashShopperId } from "./bi-hash";
import { marketingOf } from "./marketing-text";
import { redisConfigured, redisPipeline } from "./upstash";

/**
 * Keeps BI's `marketing_consent` from outliving a withdrawal. Auth0 `app_metadata.marketing_consent` is the
 * source of truth; this module never decides consent, it only copies Auth0's answer into BI.
 *
 * Two small Redis sets back it, so a BI outage at the moment of withdrawal is not the end of it:
 * - RETRY_KEY holds Auth0 subs whose BI row still has to be rewritten (read by `reconcileMarketing`).
 * - WITHDRAWN_KEY holds the shopper hashes of those withdrawals, read by `/api/bi/profiles` so a row is
 *   not listed while its BI copy is stale.
 * Both are written before the BI write is attempted and cleared once it lands.
 */

const RETRY_KEY = "kb:bi:consent:retry";
const WITHDRAWN_KEY = "kb:bi:consent:withdrawn";

/** Records a withdrawal before BI is written. False when it could not be recorded. */
export async function markWithdrawalPending(sub: string): Promise<boolean> {
  if (!redisConfigured()) return false;
  try {
    await redisPipeline([
      ["SADD", RETRY_KEY, sub],
      ["SADD", WITHDRAWN_KEY, hashShopperId(sub)],
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Drops a shopper from both sets: BI has been corrected, or the shopper has agreed again. Never throws. */
export async function clearWithdrawalPending(sub: string): Promise<void> {
  if (!redisConfigured()) return;
  try {
    await redisPipeline([
      ["SREM", RETRY_KEY, sub],
      ["SREM", WITHDRAWN_KEY, hashShopperId(sub)],
    ]);
  } catch {
    return;
  }
}

export type WithdrawnLookup =
  | { state: "checked"; hashes: Set<string> }
  | { state: "bi_only" }
  | { state: "unavailable" };

/** Hashes whose withdrawal is not yet confirmed in BI. `unavailable` means the check itself failed. */
export async function withdrawnHashes(): Promise<WithdrawnLookup> {
  if (!redisConfigured()) return { state: "bi_only" };
  try {
    const [members] = await redisPipeline([["SMEMBERS", WITHDRAWN_KEY]]);
    const list = Array.isArray(members) ? members.filter((item): item is string => typeof item === "string") : [];
    return { state: "checked", hashes: new Set(list) };
  } catch {
    return { state: "unavailable" };
  }
}

type Consent = { consent: boolean; at: string | null };

/** Sets one BI row's consent to `want`. Only an existing row is touched, and only when it differs. */
export async function setBiConsent(sql: BiSql, hash: string, want: Consent): Promise<boolean> {
  const rows = (await sql.query(
    `UPDATE bi_customer_profiles
        SET marketing_consent = $2, consent_at = $3::timestamptz,
            region = CASE WHEN $2 THEN region ELSE NULL END
      WHERE shopper_hash = $1
        AND (marketing_consent <> $2 OR consent_at IS DISTINCT FROM $3::timestamptz)
      RETURNING shopper_hash`,
    [hash, want.consent, want.consent ? want.at : null],
  )) as unknown[];
  return rows.length > 0;
}

/** Withdraws consent on every BI row whose hash is not in `consented`. Returns how many rows changed. */
export async function revokeUnlisted(sql: BiSql, consented: readonly string[]): Promise<number> {
  const rows = (await sql.query(
    `UPDATE bi_customer_profiles
        SET marketing_consent = false, consent_at = NULL, region = NULL
      WHERE marketing_consent = true AND NOT (shopper_hash = ANY($1::text[]))
      RETURNING shopper_hash`,
    [consented],
  )) as unknown[];
  return rows.length;
}

export type ReconcileSummary = {
  queue: { checked: number; corrected: number; failed: number };
  scan: { users: number; complete: boolean };
  /** BI rows set to false because Auth0 has no current consent for them. */
  revoked: number;
};

/**
 * Re-syncs BI consent from Auth0. Safe to run any number of times: each write only happens when the row
 * differs, so a second run changes nothing.
 *
 * 1. Every queued withdrawal is read from Auth0 and its BI row set to Auth0's answer.
 * 2. Every Auth0 user is scanned. When the scan reached all users, any BI row marked consented whose hash
 *    is not a currently consenting Auth0 user is withdrawn (a missed withdrawal, a deleted account, or a
 *    consent given under older wording). When it did not, that sweep is skipped: an unseen user is not
 *    proof of no consent.
 *
 * The scan only ever turns consent off. Turning it on from a snapshot could undo a withdrawal made while the
 * scan ran; a consent BI missed is only ever under-used and is written by the shopper's next profile change.
 */
export async function reconcileMarketing(sql: BiSql): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    queue: { checked: 0, corrected: 0, failed: 0 },
    scan: { users: 0, complete: false },
    revoked: 0,
  };

  let queued: string[] = [];
  let tombstones: string[] = [];
  if (redisConfigured()) {
    try {
      const [subs, hashes] = await redisPipeline([
        ["SMEMBERS", RETRY_KEY],
        ["SMEMBERS", WITHDRAWN_KEY],
      ]);
      const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
      queued = strings(subs);
      tombstones = strings(hashes);
    } catch {
      queued = [];
    }
  }

  for (const sub of queued) {
    summary.queue.checked += 1;
    try {
      const want = marketingOf(await getAppMetadata(sub));
      if (await setBiConsent(sql, hashShopperId(sub), want)) summary.queue.corrected += 1;
      await clearWithdrawalPending(sub);
    } catch {
      summary.queue.failed += 1;
    }
  }

  const { users, complete } = await listUsersAppMetadata();
  summary.scan = { users: users.length, complete };
  const consented = new Map<string, string>();
  for (const user of users) {
    const want = marketingOf(user.appMetadata);
    if (want.consent && want.at) consented.set(hashShopperId(user.userId), want.at);
  }
  if (complete) summary.revoked = await revokeUnlisted(sql, [...consented.keys()]);

  if (complete && redisConfigured() && tombstones.length > 0 && summary.queue.failed === 0) {
    try {
      await redisPipeline(tombstones.map((hash) => ["SREM", WITHDRAWN_KEY, hash]));
    } catch {
      // The tombstones only make reads stricter; leaving them is safe.
    }
  }
  return summary;
}
