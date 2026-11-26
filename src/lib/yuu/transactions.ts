import { listYuuAccounts, type YuuListedAccount } from "./account";
import { yuuAuthConfigured } from "./account";
import { YuuQueryError, YuuUnconfiguredError } from "./db";
import { yuuStoreId } from "./stores";
import { YUU_LABEL, type YuuPurchaseChannel } from "./types";

export const YUU_TXN_DEFAULT_LIMIT = 200;
export const YUU_TXN_MAX_LIMIT = 1000;
export const YUU_BUCKET_MAX_DAYS = 30;

export type YuuTxnRow = {
  member_key: string;
  sku: string;
  product_name: string;
  qty: number;
  cents: number;
  points: number;
  store_id: string;
  channel: YuuPurchaseChannel;
  at: string;
  basket_id: string;
};

export type YuuTxnBucket = {
  bucket_start: string;
  sku: string;
  qty: number;
  purchases: number;
  distinct_members: number;
  /** How many different stores sold this sku in the bucket. */
  stores: number;
};

function basketId(sku: string, at: string, storeId: string, basket: string | undefined): string {
  if (basket && /^[A-Za-z0-9_-]{1,40}$/.test(basket)) return basket;
  return `legacy-${sku}-${storeId}`;
}

function rowFrom(entry: YuuListedAccount, purchase: YuuListedAccount["account"]["purchases"][number]): YuuTxnRow {
  const storeId = yuuStoreId(purchase.store);
  return {
    member_key: entry.memberId,
    sku: purchase.sku,
    product_name: purchase.name,
    qty: purchase.qty,
    cents: purchase.cents,
    points: purchase.points,
    store_id: storeId,
    channel: purchase.channel === "partner" ? "partner" : "web",
    at: purchase.at,
    basket_id: basketId(purchase.sku, purchase.at, storeId, purchase.basket),
  };
}

/** Non-test purchases whose timestamp falls in [start, end]. Newest first. */
export function transactionRows(accounts: readonly YuuListedAccount[], startMs: number, endMs: number): YuuTxnRow[] {
  const rows: YuuTxnRow[] = [];
  for (const entry of accounts) {
    if (entry.test) continue;
    for (const purchase of entry.account.purchases) {
      const at = Date.parse(purchase.at);
      if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
      rows.push(rowFrom(entry, purchase));
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at) || a.sku.localeCompare(b.sku));
  return rows;
}

function hourStart(iso: string): string {
  const date = new Date(iso);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

/** One row per hour and sku that had at least one purchase. */
export function bucketTransactions(rows: readonly YuuTxnRow[]): YuuTxnBucket[] {
  const groups = new Map<string, { qty: number; purchases: number; members: Set<string>; stores: Set<string> }>();
  for (const row of rows) {
    const start = hourStart(row.at);
    const key = `${start}|${row.sku}`;
    let group = groups.get(key);
    if (!group) {
      group = { qty: 0, purchases: 0, members: new Set(), stores: new Set() };
      groups.set(key, group);
    }
    group.qty += row.qty;
    group.purchases += 1;
    group.members.add(row.member_key);
    group.stores.add(row.store_id);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const split = key.indexOf("|");
      return {
        bucket_start: key.slice(0, split),
        sku: key.slice(split + 1),
        qty: group.qty,
        purchases: group.purchases,
        distinct_members: group.members.size,
        stores: group.stores.size,
      };
    })
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.sku.localeCompare(b.sku));
}

export function parseTxnLimit(raw: string | null): number {
  if (raw == null || raw.trim() === "") return YUU_TXN_DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > YUU_TXN_MAX_LIMIT) {
    throw new YuuQueryError(`limit must be an integer from 1 to ${YUU_TXN_MAX_LIMIT}`);
  }
  return parsed;
}

export function parseBucketDays(raw: string | null): number {
  if (raw == null || raw.trim() === "") return 7;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > YUU_BUCKET_MAX_DAYS) {
    throw new YuuQueryError(`days must be an integer from 1 to ${YUU_BUCKET_MAX_DAYS}`);
  }
  return parsed;
}

function parseInstant(name: string, raw: string): number {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new YuuQueryError(`${name} must be an ISO 8601 timestamp`);
  return ms;
}

export async function readYuuTransactions(input: {
  now?: Date;
  startMs: number;
  endMs: number;
  limit: number;
}): Promise<{ label: typeof YUU_LABEL; scanComplete: boolean; truncated: boolean; rows: YuuTxnRow[] }> {
  if (!yuuAuthConfigured()) throw new YuuUnconfiguredError();
  const { accounts, complete } = await listYuuAccounts();
  const rows = transactionRows(accounts, input.startMs, input.endMs);
  return {
    label: YUU_LABEL,
    scanComplete: complete,
    truncated: rows.length > input.limit,
    rows: rows.slice(0, input.limit),
  };
}

export async function readYuuTransactionBuckets(input: {
  now?: Date;
  days: number;
}): Promise<{ label: typeof YUU_LABEL; bucket: "hour"; days: number; scanComplete: boolean; buckets: YuuTxnBucket[] }> {
  if (!yuuAuthConfigured()) throw new YuuUnconfiguredError();
  const now = input.now ?? new Date();
  const { accounts, complete } = await listYuuAccounts();
  const rows = transactionRows(accounts, now.getTime() - input.days * 24 * 60 * 60 * 1000, now.getTime());
  return {
    label: YUU_LABEL,
    bucket: "hour",
    days: input.days,
    scanComplete: complete,
    buckets: bucketTransactions(rows),
  };
}

export function transactionWindow(params: URLSearchParams, now: Date, windowMinutes: number | undefined): { startMs: number; endMs: number } {
  const since = params.get("since");
  const until = params.get("until");
  if ((since == null || since.trim() === "") && (until == null || until.trim() === "")) {
    const minutes = windowMinutes ?? 60;
    return { startMs: now.getTime() - minutes * 60_000, endMs: now.getTime() + 60_000 };
  }
  if (!since?.trim() || !until?.trim()) throw new YuuQueryError("since and until must be set together");
  const startMs = parseInstant("since", since.trim());
  const endMs = parseInstant("until", until.trim());
  if (startMs > endMs) throw new YuuQueryError("since must be before until");
  return { startMs, endMs };
}
