import { biPayloadSchemas } from "@/lib/bi-events";
import { biDbConfigured, getBiSql, type BiSql } from "@/lib/bi-db";
import { biHashConfigured, hashShopperId } from "@/lib/bi-hash";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoState } from "@/lib/demo/state";
import { classifyPurchases, yuuSkuBlocked, YUU_DEFAULT_WINDOW_MINUTES, type LoyaltyPurchase } from "./detector";
import { findPersona, personaHashKey, simulatedDisplayName, YUU_PERSONAS } from "./personas";
import { pointsForCents, sgdFromCents, tierForPoints } from "./tier";
import {
  YUU_LABEL,
  type YuuChannel,
  type YuuLoyaltyReport,
  type YuuMemberView,
  type YuuPanel,
  type YuuPurchaseResult,
  type YuuSignalSource,
  type YuuSignalStatus,
  type YuuSignalView,
  type YuuTierName,
} from "./types";

export class YuuUnconfiguredError extends Error {
  constructor() {
    super("yuu_unconfigured");
    this.name = "YuuUnconfiguredError";
  }
}

export class YuuUnavailableError extends Error {
  constructor() {
    super("yuu_unavailable");
    this.name = "YuuUnavailableError";
  }
}

export class YuuQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YuuQueryError";
  }
}

export function isMissingYuuTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42P01";
}

export function yuuWindowMinutes(override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 5 || override > 24 * 60) {
      throw new YuuQueryError("window_minutes must be an integer from 5 to 1440");
    }
    return override;
  }
  const raw = process.env.YUU_WINDOW_MINUTES?.trim();
  if (!raw) return YUU_DEFAULT_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 24 * 60) return YUU_DEFAULT_WINDOW_MINUTES;
  return parsed;
}

function requireSql(): BiSql {
  const sql = biDbConfigured() ? getBiSql() : null;
  if (!sql) throw new YuuUnconfiguredError();
  return sql;
}

function requireWritableSql(): BiSql {
  if (!biHashConfigured()) throw new YuuUnconfiguredError();
  return requireSql();
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asBool(value: unknown): boolean {
  return value === true;
}

type MemberRecord = {
  id: string;
  displayName: string;
  points: number;
  auth0Sub: string | null;
  isTest: boolean;
};

function memberFrom(row: Record<string, unknown>): MemberRecord {
  return {
    id: asText(row.id),
    displayName: asText(row.display_name),
    points: asInt(row.points),
    auth0Sub: row.auth0_sub == null || row.auth0_sub === "" ? null : asText(row.auth0_sub),
    isTest: asBool(row.is_test),
  };
}

export function catalogueOffer(sku: string): { name: string; priceCents: number } | null {
  const item = loadScenario().catalogue.find((row) => row.id === sku);
  if (!item) return null;
  return { name: item.name, priceCents: Math.round((item.salePrice ?? item.price) * 100) };
}

export type PurchaseWrite = {
  memberId: string;
  sku: string;
  productName: string;
  qty: number;
  amountCents: number;
  pointsEarned: number;
  channel: YuuChannel;
  shopperHash: string;
  sessionId: "yuu-web" | "yuu-sim";
  isTest: boolean;
};

export function shapePurchase(input: {
  member: MemberRecord;
  sku: string;
  qty: number;
  channel: YuuChannel;
}): PurchaseWrite {
  const offer = catalogueOffer(input.sku);
  if (!offer) throw new YuuQueryError("unknown_sku");
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 20) throw new YuuQueryError("invalid_qty");
  const amountCents = offer.priceCents * input.qty;
  const payload = biPayloadSchemas.purchase.parse({
    sku: input.sku,
    qty: input.qty,
    amountCents,
    channel: input.channel,
  });
  const hashKey = input.member.auth0Sub ?? personaHashKey(input.member.id);
  return {
    memberId: input.member.id,
    sku: payload.sku,
    productName: offer.name,
    qty: payload.qty,
    amountCents: payload.amountCents,
    pointsEarned: pointsForCents(payload.amountCents),
    channel: payload.channel,
    shopperHash: hashShopperId(hashKey),
    sessionId: input.channel === "sim" ? "yuu-sim" : "yuu-web",
    isTest: input.member.isTest,
  };
}

const ENSURE_PERSONAS = `INSERT INTO yuu_members (id, display_name, points, is_test)
SELECT r.id, r.display_name, 0, false
FROM jsonb_to_recordset($1::jsonb) AS r(id text, display_name text)
ON CONFLICT (id) DO NOTHING`;

export async function ensurePersonas(sql: BiSql = requireSql()): Promise<void> {
  const payload = YUU_PERSONAS.map((persona) => ({ id: persona.id, display_name: persona.displayName }));
  await sql.query(ENSURE_PERSONAS, [JSON.stringify(payload)]);
}

export function authMemberId(sub: string): string {
  return `auth-${hashShopperId(sub).slice(0, 16)}`;
}

async function insertAuthMember(sql: BiSql, sub: string, name: string | undefined): Promise<MemberRecord> {
  const id = authMemberId(sub);
  const rows = await sql.query(
    `INSERT INTO yuu_members (id, display_name, points, auth0_sub, is_test)
     VALUES ($1, $2, 0, $3, false)
     ON CONFLICT (auth0_sub) DO UPDATE SET display_name = yuu_members.display_name
     RETURNING id, display_name, points, auth0_sub, is_test`,
    [id, simulatedDisplayName(name), sub],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new YuuUnavailableError();
  return memberFrom(row);
}

async function readMember(sql: BiSql, id: string): Promise<MemberRecord | null> {
  const rows = await sql.query(
    `SELECT id, display_name, points, auth0_sub, is_test FROM yuu_members WHERE id = $1`,
    [id],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? memberFrom(row) : null;
}

export async function resolveMember(
  input: { memberId: string | null; shopper: { id: string; name?: string } | null },
  sql: BiSql = requireWritableSql(),
): Promise<MemberRecord> {
  await ensurePersonas(sql);
  if (input.shopper?.id) return insertAuthMember(sql, input.shopper.id, input.shopper.name);
  const persona = input.memberId ? findPersona(input.memberId) : undefined;
  if (!persona) throw new YuuQueryError("unknown_member");
  const member = await readMember(sql, persona.id);
  if (!member) throw new YuuUnavailableError();
  return member;
}

const INSERT_TXNS = `INSERT INTO yuu_transactions (member_id, sku, product_name, qty, amount_sgd, points_earned, channel)
SELECT r.member_id, r.sku, r.product_name, r.qty, r.amount_sgd::numeric, r.points_earned, r.channel
FROM jsonb_to_recordset($1::jsonb) AS r(
  member_id text, sku text, product_name text, qty int, amount_sgd text, points_earned int, channel text
)`;

const UPDATE_POINTS = `UPDATE yuu_members AS m
SET points = m.points + v.points
FROM jsonb_to_recordset($1::jsonb) AS v(id text, points int)
WHERE m.id = v.id`;

const INSERT_EVENTS = `INSERT INTO bi_events (event_type, source, shopper_hash, session_id, payload, is_test)
SELECT 'purchase', 'demo', r.shopper_hash, r.session_id, r.payload, r.is_test
FROM jsonb_to_recordset($1::jsonb) AS r(
  shopper_hash text, session_id text, payload jsonb, is_test boolean
)`;

/** Inserts purchases, points and bi_events purchase rows in one database transaction. */
export async function writePurchases(rows: readonly PurchaseWrite[], sql: BiSql = requireWritableSql()): Promise<void> {
  if (rows.length === 0) return;
  const txns = rows.map((row) => ({
    member_id: row.memberId,
    sku: row.sku,
    product_name: row.productName,
    qty: row.qty,
    amount_sgd: sgdFromCents(row.amountCents),
    points_earned: row.pointsEarned,
    channel: row.channel,
  }));
  const points = new Map<string, number>();
  for (const row of rows) points.set(row.memberId, (points.get(row.memberId) ?? 0) + row.pointsEarned);
  const pointRows = [...points.entries()].map(([id, earned]) => ({ id, points: earned }));
  const events = rows.map((row) => ({
    shopper_hash: row.shopperHash,
    session_id: row.sessionId,
    payload: { sku: row.sku, qty: row.qty, amountCents: row.amountCents, channel: row.channel },
    is_test: row.isTest,
  }));
  await sql.transaction((txn) => [
    txn.query(INSERT_TXNS, [JSON.stringify(txns)]),
    txn.query(UPDATE_POINTS, [JSON.stringify(pointRows)]),
    txn.query(INSERT_EVENTS, [JSON.stringify(events)]),
  ]);
}

async function singaporeDay(sql: BiSql): Promise<string> {
  const rows = await sql.query(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Singapore')::date, 'YYYY-MM-DD') AS day`,
  );
  const day = asText((rows[0] as { day?: unknown } | undefined)?.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new YuuUnavailableError();
  return day;
}

async function launchListed(): Promise<boolean> {
  try {
    return (await getDemoState()).listed;
  } catch {
    return false;
  }
}

const WINDOW_TXNS = `SELECT t.sku, t.product_name, t.qty, t.amount_sgd, t.member_id, m.is_test
FROM yuu_transactions t
JOIN yuu_members m ON m.id = t.member_id
WHERE t.created_at >= now() - make_interval(mins => $1::int)`;

function purchaseFrom(row: Record<string, unknown>): LoyaltyPurchase {
  const amount = typeof row.amount_sgd === "number" ? row.amount_sgd : Number(row.amount_sgd);
  return {
    sku: asText(row.sku),
    productName: asText(row.product_name),
    memberId: asText(row.member_id),
    qty: asInt(row.qty),
    amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
    isTest: asBool(row.is_test),
  };
}

const UPSERT_SIGNALS = `INSERT INTO yuu_signals (
  sku, product_name, score, window_minutes, distinct_members, total_qty, status, reason, source, proposal_ref, window_day
)
SELECT r.sku, r.product_name, r.score, r.window_minutes, r.distinct_members, r.total_qty,
       r.status, r.reason, 'detector', NULL, r.window_day::date
FROM jsonb_to_recordset($1::jsonb) AS r(
  sku text, product_name text, score int, window_minutes int, distinct_members int, total_qty int,
  status text, reason text, window_day text
)
ON CONFLICT (sku, window_minutes, window_day) DO UPDATE SET
  product_name = EXCLUDED.product_name,
  score = EXCLUDED.score,
  distinct_members = EXCLUDED.distinct_members,
  total_qty = EXCLUDED.total_qty,
  status = CASE
    WHEN yuu_signals.source = 'bi_bot' AND yuu_signals.proposal_ref IS NOT NULL THEN yuu_signals.status
    ELSE EXCLUDED.status
  END,
  reason = CASE
    WHEN yuu_signals.source = 'bi_bot' AND yuu_signals.proposal_ref IS NOT NULL THEN yuu_signals.reason
    ELSE EXCLUDED.reason
  END,
  source = CASE WHEN yuu_signals.source = 'bi_bot' THEN yuu_signals.source ELSE 'detector' END`;

/** Recomputes today's signals from the rolling window. One row per sku, window and Singapore day. */
export async function runYuuDetector(windowMinutes = yuuWindowMinutes()): Promise<YuuSignalView[]> {
  const sql = requireSql();
  const listed = await launchListed();
  const [day, txnRows] = await Promise.all([
    singaporeDay(sql),
    sql.query(WINDOW_TXNS, [windowMinutes]),
  ]);
  const purchases = (txnRows as Record<string, unknown>[]).map(purchaseFrom);
  const decisions = classifyPurchases(purchases, (sku) => yuuSkuBlocked(sku, listed));
  if (decisions.length > 0) {
    const payload = decisions.map((decision) => ({
      sku: decision.sku,
      product_name: decision.productName,
      score: decision.score,
      window_minutes: windowMinutes,
      distinct_members: decision.distinctMembers,
      total_qty: decision.totalQty,
      status: decision.status,
      reason: decision.reason,
      window_day: day,
    }));
    await sql.query(UPSERT_SIGNALS, [JSON.stringify(payload)]);
  }
  await sql.query(
    `DELETE FROM yuu_signals
     WHERE window_day = $1::date AND proposal_ref IS NULL AND NOT (sku = ANY($2::text[]))`,
    [day, decisions.map((decision) => decision.sku)],
  );
  return readSignals(sql, day);
}

function signalFrom(row: Record<string, unknown>): YuuSignalView {
  const status = asText(row.status);
  const source = asText(row.source);
  return {
    id: asText(row.id),
    sku: asText(row.sku),
    productName: asText(row.product_name),
    score: asInt(row.score),
    windowMinutes: asInt(row.window_minutes),
    distinctMembers: asInt(row.distinct_members),
    totalQty: asInt(row.total_qty),
    status: (status === "escalated" || status === "shortlisted" || status === "dropped" ? status : "dropped") as YuuSignalStatus,
    reason: row.reason == null ? null : asText(row.reason),
    source: (source === "bi_bot" ? "bi_bot" : "detector") as YuuSignalSource,
    proposalRef: row.proposal_ref == null || row.proposal_ref === "" ? null : asText(row.proposal_ref),
  };
}

async function readSignals(sql: BiSql, day: string): Promise<YuuSignalView[]> {
  const rows = await sql.query(
    `SELECT id::text AS id, sku, product_name, score, window_minutes, distinct_members, total_qty,
            status, reason, source, proposal_ref
     FROM yuu_signals
     WHERE window_day = $1::date`,
    [day],
  );
  return (rows as Record<string, unknown>[]).map(signalFrom).sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
}

export async function findSignal(sku: string, windowMinutes: number): Promise<YuuSignalView | null> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const rows = await sql.query(
    `SELECT id::text AS id, sku, product_name, score, window_minutes, distinct_members, total_qty,
            status, reason, source, proposal_ref
     FROM yuu_signals
     WHERE sku = $1 AND window_minutes = $2 AND window_day = $3::date`,
    [sku, windowMinutes, day],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? signalFrom(row) : null;
}

export async function markSignalFromBot(sku: string, windowMinutes: number, rationale: string, proposalRef: string): Promise<YuuSignalView | null> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const rows = await sql.query(
    `UPDATE yuu_signals
     SET source = 'bi_bot', reason = $1, proposal_ref = $2
     WHERE sku = $3 AND window_minutes = $4 AND window_day = $5::date
       AND status IN ('shortlisted', 'escalated')
       AND proposal_ref IS NULL
     RETURNING id::text AS id, sku, product_name, score, window_minutes, distinct_members, total_qty,
               status, reason, source, proposal_ref`,
    [rationale, proposalRef, sku, windowMinutes, day],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? signalFrom(row) : null;
}

function memberView(row: Record<string, unknown>): YuuMemberView {
  const points = asInt(row.points);
  return {
    id: asText(row.id),
    displayName: asText(row.display_name),
    points,
    tier: tierForPoints(points),
    test: asBool(row.is_test),
  };
}

export async function readYuuPanel(windowMinutes = yuuWindowMinutes()): Promise<YuuPanel> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const [signals, members] = await Promise.all([readSignals(sql, day), sql.query(
    `SELECT id, display_name, points, is_test FROM yuu_members`,
  )]);
  return {
    label: YUU_LABEL,
    windowMinutes,
    signals,
    members: (members as Record<string, unknown>[]).map(memberView).sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

export async function readLoyaltyReport(windowMinutes = yuuWindowMinutes()): Promise<YuuLoyaltyReport> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const [memberRows, txnRows, signals] = await Promise.all([
    sql.query(`SELECT points, is_test FROM yuu_members`),
    sql.query(WINDOW_TXNS, [windowMinutes]),
    readSignals(sql, day),
  ]);
  const tierMix: Record<YuuTierName, number> = { Member: 0, Silver: 0, Gold: 0 };
  let excludedTest = 0;
  for (const row of memberRows as Record<string, unknown>[]) {
    if (asBool(row.is_test)) {
      excludedTest += 1;
      continue;
    }
    tierMix[tierForPoints(asInt(row.points))] += 1;
  }
  const purchases = (txnRows as Record<string, unknown>[]).map(purchaseFrom);
  const live = purchases.filter((row) => !row.isTest);
  const decisions = classifyPurchases(live);
  const totalAmountCents = live.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    label: YUU_LABEL,
    windowMinutes,
    members: {
      count: tierMix.Member + tierMix.Silver + tierMix.Gold,
      tierMix,
      excludedTest,
    },
    transactions: {
      count: live.length,
      totalQty: live.reduce((sum, row) => sum + row.qty, 0),
      totalAmountSgd: sgdFromCents(totalAmountCents),
    },
    skus: decisions.map((decision) => ({
      sku: decision.sku,
      productName: decision.productName,
      distinctMembers: decision.distinctMembers,
      repeatMembers: decision.repeatMembers,
      repeatPurchases: decision.repeatPurchases,
      totalQty: decision.totalQty,
      totalAmountSgd: decision.totalAmountSgd,
      score: decision.score,
    })),
    signals,
  };
}

export async function purchaseYuu(input: {
  sku: string;
  qty: number;
  memberId: string | null;
  shopper: { id: string; name?: string } | null;
  channel: YuuChannel;
  detect?: boolean;
}): Promise<YuuPurchaseResult> {
  const sql = requireWritableSql();
  const member = await resolveMember({ memberId: input.memberId, shopper: input.shopper }, sql);
  const row = shapePurchase({ member, sku: input.sku, qty: input.qty, channel: input.channel });
  await writePurchases([row], sql);
  if (input.detect !== false) {
    try {
      await runYuuDetector();
    } catch (error) {
      if (error instanceof YuuUnconfiguredError) throw error;
      console.error("[yuu] detector failed", error instanceof Error ? error.name : "unknown");
    }
  }
  const updated = await readMember(sql, member.id);
  const points = updated?.points ?? member.points + row.pointsEarned;
  return {
    label: YUU_LABEL,
    memberId: member.id,
    displayName: updated?.displayName ?? member.displayName,
    sku: row.sku,
    productName: row.productName,
    qty: row.qty,
    amountSgd: sgdFromCents(row.amountCents),
    pointsEarned: row.pointsEarned,
    points,
    tier: tierForPoints(points),
    channel: row.channel,
  };
}

const RESET_TXNS = `DELETE FROM yuu_transactions`;
const RESET_SIGNALS = `DELETE FROM yuu_signals`;
const RESET_POINTS = `UPDATE yuu_members SET points = 0 WHERE id = ANY($1::text[])`;
const RESET_EXTRA_MEMBERS = `DELETE FROM yuu_members WHERE NOT (id = ANY($1::text[]))`;
const RESET_EVENTS = `DELETE FROM bi_events
WHERE event_type = 'purchase' AND source = 'demo' AND session_id = ANY($1::text[])`;

/**
 * Clears simulated purchases and signals, zeros seeded persona points, and drops members
 * created for signed-in shoppers during the demo. Seeded personas stay. A missing table
 * (migration not applied) is "absent" so the Pelita reset can still run.
 */
export async function resetYuuLoyalty(): Promise<"cleared" | "skipped" | "absent"> {
  if (!biDbConfigured()) return "skipped";
  const sql = getBiSql();
  if (!sql) return "skipped";
  const ids = YUU_PERSONAS.map((persona) => persona.id);
  try {
    await sql.transaction((txn) => [
      txn.query(RESET_TXNS),
      txn.query(RESET_SIGNALS),
      txn.query(RESET_POINTS, [ids]),
      txn.query(RESET_EXTRA_MEMBERS, [ids]),
      txn.query(RESET_EVENTS, [["yuu-web", "yuu-sim"]]),
    ]);
    return "cleared";
  } catch (error) {
    if (isMissingYuuTable(error)) return "absent";
    throw error;
  }
}
