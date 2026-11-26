import { biDbConfigured, getBiSql, type BiSql } from "@/lib/bi-db";
import { biHashConfigured, hashShopperId } from "@/lib/bi-hash";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoState } from "@/lib/demo/state";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import {
  clearYuuAccounts,
  listYuuAccounts,
  purchasesInWindow,
  readShopperYuu,
  recordShopperPurchase,
  storedPurchase,
  yuuAuthConfigured,
  YuuMetadataFullError,
  type YuuListedAccount,
} from "./account";
import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { classifyPurchases, yuuSkuBlocked, yuuThresholds, YUU_DEFAULT_WINDOW_MINUTES, type LoyaltyPurchase } from "./detector";
import { YUU_DEFAULT_STORE_ID, isYuuStoreId } from "./stores";
import {
  escalationBody,
  postEscalation,
  yuuWebhookUrl,
  type YuuEscalationNotice,
} from "./webhook";
import { pointsForCents, sgdFromCents, tierForPoints } from "./tier";
import {
  YUU_LABEL,
  type YuuChannel,
  type YuuPurchaseChannel,
  type YuuWebhookView,
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

function requireLedgerConfig(): void {
  if (!yuuAuthConfigured()) throw new YuuUnconfiguredError();
}

function asInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function catalogueOffer(sku: string): { name: string; priceCents: number } | null {
  const item = loadScenario().catalogue.find((row) => row.id === sku);
  if (!item) return null;
  return { name: item.name, priceCents: Math.round((item.salePrice ?? item.price) * 100) };
}

/** Stable id for the shopper-facing purchase response. Not an Auth0 sub. */
export const YUU_SELF = "self";

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

type Ledger = { accounts: YuuListedAccount[]; complete: boolean };

async function loadLedger(): Promise<Ledger> {
  requireLedgerConfig();
  return listYuuAccounts();
}

function windowPurchases(ledger: Ledger, windowMinutes: number, now: Date): LoyaltyPurchase[] {
  const rows: LoyaltyPurchase[] = [];
  for (const entry of ledger.accounts) {
    for (const purchase of purchasesInWindow(entry.account, windowMinutes, now)) {
      rows.push({
        sku: purchase.sku,
        productName: purchase.name,
        memberId: entry.memberId,
        qty: purchase.qty,
        amountCents: purchase.cents,
        isTest: entry.test,
        storeId: purchase.store ?? YUU_DEFAULT_STORE_ID,
      });
    }
  }
  return rows;
}

const SIGNAL_COLUMNS = `id::text AS id, sku, product_name, score, window_minutes, distinct_members, total_qty,
            status, reason, source, proposal_ref, webhook_status, webhook_code`;

function storesFor(sku: string, purchases: readonly LoyaltyPurchase[]): { store_id: string; qty: number }[] {
  const totals = new Map<string, number>();
  for (const row of purchases) {
    if (row.isTest || row.sku !== sku) continue;
    const storeId = row.storeId && isYuuStoreId(row.storeId) ? row.storeId : YUU_DEFAULT_STORE_ID;
    totals.set(storeId, (totals.get(storeId) ?? 0) + row.qty);
  }
  return [...totals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([store_id, qty]) => ({ store_id, qty }));
}

/**
 * Recomputes today's signals from Auth0 purchases inside the rolling window.
 * A new escalation is posted to the webhook after the response unless `awaitWebhook` is set,
 * which the ops refresh uses so the returned panel can show the delivery status.
 */
export async function runYuuDetector(
  windowMinutes = yuuWindowMinutes(),
  now = new Date(),
  options?: { awaitWebhook?: boolean },
): Promise<YuuSignalView[]> {
  const sql = requireSql();
  const ledger = await loadLedger();
  const listed = await launchListed();
  const day = await singaporeDay(sql);
  const purchases = windowPurchases(ledger, windowMinutes, now);
  const thresholds = yuuThresholds();
  const decisions = classifyPurchases(purchases, (sku) => yuuSkuBlocked(sku, listed), thresholds);
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
  const signals = await readSignals(sql, day);
  const detectedAt = now.toISOString();
  const notices: YuuEscalationNotice[] = [];
  for (const decision of decisions) {
    if (decision.status !== "escalated") continue;
    const signal = signals.find((row) => row.sku === decision.sku && row.windowMinutes === windowMinutes);
    if (!signal || signal.webhook?.status === "sent") continue;
    notices.push({
      signalId: signal.id,
      sku: decision.sku,
      productName: decision.productName,
      score: decision.score,
      repeatMembers: decision.repeatMembers,
      distinctMembers: decision.distinctMembers,
      qty: decision.totalQty,
      windowMinutes,
      minRepeatMembers: thresholds.minRepeatMembers,
      minScore: thresholds.minScore,
      stores: storesFor(decision.sku, purchases),
      scanComplete: ledger.complete,
      detectedAt,
    });
  }
  const deliver = () => deliverEscalations(notices);
  if (options?.awaitWebhook || process.env.VITEST === "true") {
    await deliver();
    return readSignals(sql, day);
  }
  try {
    after(() => void deliver().catch(() => undefined));
  } catch {
    void deliver().catch(() => undefined);
  }
  return signals;
}

const CLAIM_WEBHOOK = `UPDATE yuu_signals
SET webhook_status = 'pending', webhook_code = NULL
WHERE id::text = $1 AND (webhook_status IS NULL OR webhook_status IN ('failed', 'unconfigured'))
RETURNING id::text AS id`;

const MARK_WEBHOOK = `UPDATE yuu_signals
SET webhook_status = $2, webhook_code = $3
WHERE id::text = $1 AND (webhook_status IS DISTINCT FROM 'sent')
RETURNING id::text AS id`;

async function deliverEscalations(notices: readonly YuuEscalationNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const sql = requireSql();
  for (const notice of notices) {
    if (!yuuWebhookUrl()) {
      await sql.query(MARK_WEBHOOK, [notice.signalId, "unconfigured", null]);
      continue;
    }
    const claimed = await sql.query(CLAIM_WEBHOOK, [notice.signalId]);
    if (!claimed.length) continue;
    const body = escalationBody(notice);
    const result = await postEscalation(body);
    if (!result.configured) {
      await sql.query(MARK_WEBHOOK, [notice.signalId, "unconfigured", null]);
      continue;
    }
    await sql.query(MARK_WEBHOOK, [notice.signalId, result.ok ? "sent" : "failed", result.status]);
  }
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
    webhook: webhookOf(row),
  };
}

function webhookOf(row: Record<string, unknown>): YuuWebhookView | null {
  const status = row.webhook_status;
  if (status !== "sent" && status !== "failed" && status !== "unconfigured" && status !== "pending") return null;
  const code = row.webhook_code;
  return { status, code: typeof code === "number" && Number.isInteger(code) ? code : code == null ? null : Number.isFinite(Number(code)) ? Math.trunc(Number(code)) : null };
}

async function readSignals(sql: BiSql, day: string): Promise<YuuSignalView[]> {
  const rows = await sql.query(
    `SELECT ${SIGNAL_COLUMNS}
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
    `SELECT ${SIGNAL_COLUMNS}
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
     RETURNING ${SIGNAL_COLUMNS}`,
    [rationale, proposalRef, sku, windowMinutes, day],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? signalFrom(row) : null;
}

function memberView(entry: YuuListedAccount): YuuMemberView {
  return {
    id: entry.memberId,
    displayName: `Member ${entry.memberId.slice(0, 8)}`,
    points: entry.account.points,
    tier: tierForPoints(entry.account.points),
    test: entry.test,
  };
}

async function readLedgerSoft(): Promise<Ledger | null> {
  if (!yuuAuthConfigured()) return { accounts: [], complete: true };
  try {
    return await listYuuAccounts();
  } catch (error) {
    console.error("[yuu] auth0 read failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

export async function readYuuPanel(windowMinutes = yuuWindowMinutes()): Promise<YuuPanel> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const [signals, ledger] = await Promise.all([readSignals(sql, day), readLedgerSoft()]);
  const thresholds = yuuThresholds();
  const members = (ledger?.accounts ?? []).map(memberView).sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    label: YUU_LABEL,
    windowMinutes,
    minRepeatMembers: thresholds.minRepeatMembers,
    minScore: thresholds.minScore,
    scanComplete: ledger?.complete ?? false,
    signals,
    members,
  };
}

export async function readLoyaltyReport(windowMinutes = yuuWindowMinutes(), now = new Date()): Promise<YuuLoyaltyReport> {
  const sql = requireSql();
  const day = await singaporeDay(sql);
  const [ledger, signals] = await Promise.all([loadLedger(), readSignals(sql, day)]);
  const thresholds = yuuThresholds();
  const tierMix: Record<YuuTierName, number> = { Member: 0, Silver: 0, Gold: 0 };
  let excludedTest = 0;
  for (const entry of ledger.accounts) {
    if (entry.test) {
      excludedTest += 1;
      continue;
    }
    tierMix[tierForPoints(entry.account.points)] += 1;
  }
  const purchases = windowPurchases(ledger, windowMinutes, now);
  const live = purchases.filter((row) => !row.isTest);
  const decisions = classifyPurchases(live, () => false, thresholds);
  const totalAmountCents = live.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    label: YUU_LABEL,
    windowMinutes,
    minRepeatMembers: thresholds.minRepeatMembers,
    minScore: thresholds.minScore,
    scanComplete: ledger.complete,
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

const INSERT_EVENT = `INSERT INTO bi_events (event_type, source, shopper_hash, session_id, payload, is_test)
VALUES ('purchase', 'demo', $1, $2, $3::jsonb, $4)`;

export async function purchaseYuu(input: {
  sku: string;
  qty: number;
  shopperId: string;
  channel?: YuuPurchaseChannel;
  storeId?: string;
  detect?: boolean;
  now?: Date;
}): Promise<YuuPurchaseResult> {
  if (!mgmtConfigured() || !biHashConfigured()) throw new YuuUnconfiguredError();
  requireSql();
  const offer = catalogueOffer(input.sku);
  if (!offer) throw new YuuQueryError("unknown_sku");
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 20) throw new YuuQueryError("invalid_qty");
  if (input.storeId !== undefined && !isYuuStoreId(input.storeId)) throw new YuuQueryError("unknown_store");
  const now = input.now ?? new Date();
  const channel: YuuPurchaseChannel = input.channel === "partner" ? "partner" : "web";
  const amountCents = offer.priceCents * input.qty;
  const pointsEarned = pointsForCents(amountCents);
  const purchase = storedPurchase({
    sku: input.sku,
    name: offer.name,
    qty: input.qty,
    cents: amountCents,
    points: pointsEarned,
    at: now.toISOString(),
    channel,
    store: input.storeId,
    basket: randomBytes(8).toString("hex"),
  });
  let recorded: { account: { points: number }; test: boolean };
  try {
    recorded = await recordShopperPurchase(input.shopperId, purchase);
  } catch (error) {
    if (error instanceof YuuMetadataFullError) throw new YuuQueryError("metadata_full");
    throw error;
  }
  const sql = getBiSql();
  if (sql) {
    try {
      await sql.query(INSERT_EVENT, [
        hashShopperId(input.shopperId),
        channel === "partner" ? "yuu-partner" : "yuu-web",
        JSON.stringify({ sku: purchase.sku, qty: purchase.qty, amountCents: purchase.cents, channel }),
        recorded.test,
      ]);
    } catch (error) {
      console.error("[yuu] event write failed", error instanceof Error ? error.name : "unknown");
    }
  }
  if (input.detect !== false) {
    try {
      await runYuuDetector(yuuWindowMinutes(), now);
    } catch (error) {
      if (error instanceof YuuUnconfiguredError) throw error;
      console.error("[yuu] detector failed", error instanceof Error ? error.name : "unknown");
    }
  }
  const points = recorded.account.points;
  return {
    label: YUU_LABEL,
    memberId: YUU_SELF,
    displayName: "You",
    sku: purchase.sku,
    productName: purchase.name,
    qty: purchase.qty,
    amountSgd: sgdFromCents(amountCents),
    pointsEarned,
    points,
    tier: tierForPoints(points),
    channel: channel satisfies YuuChannel,
  };
}

export async function readSignedInBalance(userId: string): Promise<{ points: number } | null> {
  if (!mgmtConfigured()) return null;
  return readShopperYuu(userId);
}

const RESET_TXNS = `DELETE FROM yuu_transactions`;
const RESET_SIGNALS = `DELETE FROM yuu_signals`;
const RESET_MEMBERS = `DELETE FROM yuu_members`;
const RESET_EVENTS = `DELETE FROM bi_events
WHERE event_type = 'purchase' AND source = 'demo' AND session_id = ANY($1::text[])`;

/**
 * Clears the `yuu` key on every Auth0 user that has one, then deletes Neon signal rows
 * (the proposal queue) and any leftover simulated member or transaction rows.
 * A missing table (migration not applied) is "absent" so the Pelita reset can still run
 * after the Auth0 keys are cleared. Auth0's user scan stops at 1000 users; a longer
 * directory is logged and the users already scanned are still cleared.
 */
export async function resetYuuLoyalty(): Promise<"cleared" | "skipped" | "absent"> {
  if (mgmtConfigured()) {
    const cleared = await clearYuuAccounts();
    if (!cleared.complete) console.error("[yuu] reset scan incomplete");
  }
  if (!biDbConfigured()) return "skipped";
  const sql = getBiSql();
  if (!sql) return "skipped";
  try {
    await sql.transaction((txn) => [
      txn.query(RESET_TXNS),
      txn.query(RESET_SIGNALS),
      txn.query(RESET_MEMBERS),
      txn.query(RESET_EVENTS, [["yuu-web", "yuu-sim", "yuu-partner"]]),
    ]);
    return "cleared";
  } catch (error) {
    if (isMissingYuuTable(error)) return "absent";
    throw error;
  }
}
