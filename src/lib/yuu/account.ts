import { listUsersAppMetadata, mgmtConfigured, getAppMetadata, patchAppMetadata } from "@/lib/auth0-mgmt";
import { biHashConfigured, hashShopperId } from "@/lib/bi-hash";
import { isTestShopper } from "@/lib/bi-track";

/**
 * yuu purchases live on Auth0 `app_metadata.yuu`, the same document KoffeeBean uses for orders
 * (`app_metadata.orders`). `user_metadata` is writable by the shopper, so points stored there could
 * be edited by the account holder. `app_metadata` is replaced only by the Management API.
 *
 * Auth0 merges top-level keys and replaces each patched key entirely. Writers send only `yuu`.
 * A patch of `yuu: null` deletes that key and leaves cart, orders, and the rest in place.
 *
 * Auth0 caps the whole of `app_metadata` at 16 KB. `yuu` itself stays under 4 KB, and a write
 * trims the oldest purchases until the whole document still fits in 15 KB.
 */

export const YUU_META_KEY = "yuu";
/** Newest purchases kept before the byte cap. Oldest drop first. */
export const YUU_PURCHASE_CAP = 40;
/** Hard cap on the `yuu` value alone. */
export const YUU_META_MAX_BYTES = 4096;
/** Same headroom Barista uses so a later order write still fits in Auth0's 16 KB limit. */
export const YUU_APP_METADATA_BUDGET = 15_000;
const NAME_MAX = 80;

export type YuuStoredPurchase = {
  sku: string;
  name: string;
  qty: number;
  cents: number;
  points: number;
  at: string;
};

export type YuuAccount = {
  /** Running total. Trimming old purchases does not reduce it. */
  points: number;
  purchases: YuuStoredPurchase[];
};

export type YuuListedAccount = {
  /** HMAC of the Auth0 sub. The sub itself never leaves this module. */
  memberId: string;
  account: YuuAccount;
  test: boolean;
};

export class YuuMetadataFullError extends Error {
  constructor() {
    super("metadata_full");
    this.name = "YuuMetadataFullError";
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function finiteInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function clipName(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, NAME_MAX);
}

export function storedPurchase(input: {
  sku: string;
  name: string;
  qty: number;
  cents: number;
  points: number;
  at: string;
}): YuuStoredPurchase {
  return {
    sku: input.sku,
    name: clipName(input.name) || input.sku,
    qty: input.qty,
    cents: input.cents,
    points: input.points,
    at: input.at,
  };
}

function readPurchase(value: unknown): YuuStoredPurchase | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.sku !== "string" || !/^PL-\d{5}$/.test(row.sku)) return null;
  if (typeof row.name !== "string" || !row.name.trim()) return null;
  const qty = finiteInt(row.qty, 1, 20);
  const cents = finiteInt(row.cents, 0, 100_000_000);
  const points = finiteInt(row.points, 0, 1_000_000);
  if (qty == null || cents == null || points == null) return null;
  if (typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null;
  return { sku: row.sku, name: clipName(row.name) || row.sku, qty, cents, points, at: row.at };
}

/** Defensive read of `app_metadata.yuu`. Missing or empty means this shopper has no yuu history. */
export function readYuuAccount(value: unknown): YuuAccount | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const purchases: YuuStoredPurchase[] = [];
  if (Array.isArray(record.purchases)) {
    for (const row of record.purchases) {
      const purchase = readPurchase(row);
      if (purchase) purchases.push(purchase);
    }
  }
  const storedPoints = finiteInt(record.points, 0, 10_000_000);
  const summed = purchases.reduce((sum, row) => sum + row.points, 0);
  const points = Math.max(storedPoints ?? 0, summed);
  if (purchases.length === 0 && points === 0) return null;
  return capYuu({ points, purchases });
}

/** Drops the oldest purchases until both the count cap and the byte cap hold. Points stay. */
export function capYuu(account: YuuAccount): YuuAccount {
  let purchases = account.purchases.slice(-YUU_PURCHASE_CAP);
  let next: YuuAccount = { points: account.points, purchases };
  while (purchases.length > 1 && byteLength(next) > YUU_META_MAX_BYTES) {
    purchases = purchases.slice(1);
    next = { points: account.points, purchases };
  }
  return next;
}

export function withPurchase(account: YuuAccount | null, purchase: YuuStoredPurchase): YuuAccount {
  const base = account ?? { points: 0, purchases: [] };
  return capYuu({
    points: Math.min(10_000_000, base.points + purchase.points),
    purchases: [...base.purchases, purchase],
  });
}

/** Purchases whose timestamp falls inside the rolling window. Future stamps more than a minute ahead are ignored. */
export function purchasesInWindow(account: YuuAccount, windowMinutes: number, now: Date): YuuStoredPurchase[] {
  const end = now.getTime() + 60_000;
  const start = now.getTime() - windowMinutes * 60_000;
  return account.purchases.filter((purchase) => {
    const at = Date.parse(purchase.at);
    return Number.isFinite(at) && at >= start && at <= end;
  });
}

function fits(meta: Record<string, unknown>, account: YuuAccount): boolean {
  return byteLength({ ...meta, [YUU_META_KEY]: account }) <= YUU_APP_METADATA_BUDGET;
}

/**
 * Trims oldest purchases until the whole `app_metadata` document fits. The newest purchase
 * (the one just recorded) has to remain, otherwise the write is refused.
 */
function fitAccount(meta: Record<string, unknown>, account: YuuAccount, purchase: YuuStoredPurchase): YuuAccount {
  let next = account;
  while (next.purchases.length > 1 && !fits(meta, next)) {
    next = { points: next.points, purchases: next.purchases.slice(1) };
  }
  if (!fits(meta, next) || !next.purchases.includes(purchase)) throw new YuuMetadataFullError();
  return next;
}

export function yuuAuthConfigured(): boolean {
  return mgmtConfigured() && biHashConfigured();
}

export async function recordShopperPurchase(userId: string, purchase: YuuStoredPurchase): Promise<{ account: YuuAccount; test: boolean }> {
  const meta = await getAppMetadata(userId);
  const next = fitAccount(meta, withPurchase(readYuuAccount(meta[YUU_META_KEY]), purchase), purchase);
  await patchAppMetadata(userId, { [YUU_META_KEY]: next });
  return { account: next, test: isTestShopper(meta, userId) };
}

export async function readShopperYuu(userId: string): Promise<YuuAccount | null> {
  const meta = await getAppMetadata(userId);
  return readYuuAccount(meta[YUU_META_KEY]);
}

/** Every shopper who has a yuu key. Member ids are hashes. Raw subs are not returned. */
export async function listYuuAccounts(): Promise<{ accounts: YuuListedAccount[]; complete: boolean }> {
  const { users, complete } = await listUsersAppMetadata();
  const accounts: YuuListedAccount[] = [];
  for (const user of users) {
    const account = readYuuAccount(user.appMetadata[YUU_META_KEY]);
    if (!account) continue;
    accounts.push({
      memberId: hashShopperId(user.userId),
      account,
      test: isTestShopper(user.appMetadata, user.userId),
    });
  }
  return { accounts, complete };
}

/**
 * Deletes only the `yuu` key on users that have one. Other `app_metadata` keys are not sent,
 * so Auth0 leaves them as stored. An incomplete user scan is reported and not treated as done.
 */
export async function clearYuuAccounts(): Promise<{ cleared: number; complete: boolean }> {
  const { users, complete } = await listUsersAppMetadata();
  let cleared = 0;
  for (const user of users) {
    if (user.appMetadata[YUU_META_KEY] == null) continue;
    await patchAppMetadata(user.userId, { [YUU_META_KEY]: null });
    cleared += 1;
  }
  return { cleared, complete };
}
