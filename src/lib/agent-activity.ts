import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { ACTIVITY_ACTIONS, type ActivityAction, type ActivityEntry, type ActivityStatus } from "./agent-activity-text";

/**
 * The agent audit trail lives under the Auth0 `app_metadata.agent_activity` key, newest first.
 * Auth0 caps all of `app_metadata` at 16 KB, so only the newest `ACTIVITY_CAP` entries are kept
 * and free text is trimmed.
 */
export const ACTIVITY_CAP = 30;
const SUBJECT_MAX = 80;
const REASON_MAX = 200;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES: readonly ActivityStatus[] = ["waiting", "done", "declined", "undone"];

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Defensive read: malformed rows are dropped, text is trimmed, order is newest first. */
export function normalizeActivity(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: ActivityEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id) || !isIso(r.ts)) continue;
    if (typeof r.agent !== "string" || !ID.test(r.agent)) continue;
    if (!ACTIVITY_ACTIONS.includes(r.action as ActivityAction)) continue;
    if (!STATUSES.includes(r.status as ActivityStatus)) continue;
    const amount = typeof r.amountCents === "number" && Number.isInteger(r.amountCents) && r.amountCents >= 0 ? r.amountCents : null;
    rows.push({
      id: r.id,
      ts: r.ts,
      agent: r.agent,
      action: r.action as ActivityAction,
      subject: text(r.subject, SUBJECT_MAX),
      reason: text(r.reason, REASON_MAX),
      amountCents: amount,
      orderId: typeof r.orderId === "string" && r.orderId ? r.orderId.slice(0, 40) : null,
      consent: isIso(r.consent) ? r.consent : null,
      status: r.status as ActivityStatus,
    });
  }
  return rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, ACTIVITY_CAP);
}

/** Pure: inserts `entry`, or replaces the entry with the same id, then re-sorts and caps. */
export function upsertActivity(entries: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return normalizeActivity([entry, ...entries.filter((row) => row.id !== entry.id)]);
}

export type ActivityChange = Partial<Pick<ActivityEntry, "status" | "amountCents" | "orderId" | "reason" | "subject" | "consent">>;

/** Pure: applies `change` to the entry with `id` and stamps `ts`. Returns null when there is no such entry. */
export function transitionActivity(
  entries: readonly ActivityEntry[],
  id: string,
  change: ActivityChange,
  now: Date,
): ActivityEntry[] | null {
  const found = entries.find((row) => row.id === id);
  if (!found) return null;
  return upsertActivity(entries, { ...found, ...change, ts: now.toISOString() });
}

/** Pure: marks the newest not-yet-undone entry for `orderId` as undone. Returns null when none matches. */
export function undoActivityForOrder(entries: readonly ActivityEntry[], orderId: string, now: Date): ActivityEntry[] | null {
  const found = entries.find((row) => row.orderId === orderId && row.action === "place_order" && row.status !== "undone");
  return found ? transitionActivity(entries, found.id, { status: "undone" }, now) : null;
}

export function newActivityId(prefix: string, token: string): string {
  return `${prefix}_${token}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/** The `consentAt` of the shopper's agent consent, read raw so this module stays free of store-meta. */
export function consentAtOf(meta: Record<string, unknown>): string | null {
  const prefs = meta.agent_prefs;
  const at = prefs && typeof prefs === "object" ? (prefs as Record<string, unknown>).consentAt : undefined;
  return isIso(at) ? at : null;
}

/** Writes (or replaces) one entry, stamped with the consent in force now. One Management API read and one patch. */
export async function recordActivity(userId: string, entry: Omit<ActivityEntry, "consent">): Promise<void> {
  const meta = await getAppMetadata(userId);
  const stamped = { ...entry, consent: consentAtOf(meta) };
  await patchAppMetadata(userId, { agent_activity: upsertActivity(normalizeActivity(meta.agent_activity), stamped) });
}

/** Moves an existing entry to a new status. A missing entry is ignored. */
export async function changeActivity(userId: string, id: string, change: ActivityChange, now = new Date()): Promise<void> {
  const meta = await getAppMetadata(userId);
  const next = transitionActivity(normalizeActivity(meta.agent_activity), id, { consent: consentAtOf(meta), ...change }, now);
  if (next) await patchAppMetadata(userId, { agent_activity: next });
}

/** Moves the newest waiting entry of `action` to a new status. Used when the client does not know the id. */
export async function changeLatestWaiting(
  userId: string,
  action: ActivityAction,
  change: ActivityChange,
  now = new Date(),
): Promise<void> {
  const meta = await getAppMetadata(userId);
  const entries = normalizeActivity(meta.agent_activity);
  const found = entries.find((row) => row.action === action && row.status === "waiting");
  if (!found) return;
  const next = transitionActivity(entries, found.id, { consent: consentAtOf(meta), ...change }, now);
  if (next) await patchAppMetadata(userId, { agent_activity: next });
}

/** Audit writes never block or fail the shopper's action. */
export async function bestEffort(task: Promise<unknown>): Promise<void> {
  try {
    await task;
  } catch {
    console.error("[activity] write failed");
  }
}

/** Waiting entries nobody answered for this long are shown as declined; their signed confirmations have expired. */
export const WAITING_EXPIRES_MS = 15 * 60 * 1000;

export function expireStale(entries: readonly ActivityEntry[], now: Date): ActivityEntry[] {
  return entries.map((entry) =>
    entry.status === "waiting" && now.getTime() - Date.parse(entry.ts) > WAITING_EXPIRES_MS
      ? { ...entry, status: "declined" as const }
      : entry,
  );
}
