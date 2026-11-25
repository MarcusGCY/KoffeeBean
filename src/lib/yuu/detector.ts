import { loadScenario } from "@/lib/demo/scenario";
import { sgdFromCents } from "./tier";
import type { YuuSignalStatus, YuuSkuStat } from "./types";

/** Rolling window used for the demo unless YUU_WINDOW_MINUTES overrides it. */
export const YUU_DEFAULT_WINDOW_MINUTES = 60;

/** A repeat trend needs at least this many members who each bought the sku twice. */
export const YUU_MIN_REPEAT_MEMBERS = 3;

/** score = distinct repeat members × extra purchases. Below this, the sku is not a trend. */
export const YUU_MIN_SCORE = 6;

/** At most this many skus are shortlisted or escalated on one day. The strongest is escalated. */
export const YUU_SHORTLIST_LIMIT = 3;

/** One member, and either a large quantity or several separate purchases. */
export const YUU_BULK_QTY = 5;
export const YUU_BULK_TXNS = 3;

export const YUU_REASON = {
  testMembers: "test members",
  singleMemberBulk: "single-member bulk",
  belowThreshold: "below threshold",
  alreadyListed: "already on promo/listed",
  escalated: "strongest repeat trend",
  shortlisted: "repeat trend, inside the daily shortlist",
} as const;

export type LoyaltyPurchase = {
  sku: string;
  productName: string;
  memberId: string;
  qty: number;
  amountCents: number;
  isTest: boolean;
};

export type LoyaltyDecision = YuuSkuStat & {
  status: YuuSignalStatus;
  reason: string;
};

/**
 * True when the sku is already on the Pelita shelf (or the launched product is now listed).
 * The demand-gap product stays eligible until approval 2 lists it. Its fixture promo is the
 * promo the launch would publish, so it does not count as already on promo while unlisted.
 */
export function yuuSkuBlocked(sku: string, launchListed: boolean): boolean {
  const item = loadScenario().catalogue.find((row) => row.id === sku);
  if (!item) return false;
  if (item.stock.status !== "unlisted") return true;
  return item.launchedInDemo === true && launchListed;
}

type SkuBucket = {
  sku: string;
  productName: string;
  totalQty: number;
  totalAmountCents: number;
  members: Map<string, number>;
};

function bucketPurchases(rows: readonly LoyaltyPurchase[]): SkuBucket[] {
  const bySku = new Map<string, SkuBucket>();
  for (const row of rows) {
    if (row.isTest) continue;
    let bucket = bySku.get(row.sku);
    if (!bucket) {
      bucket = { sku: row.sku, productName: row.productName, totalQty: 0, totalAmountCents: 0, members: new Map() };
      bySku.set(row.sku, bucket);
    }
    bucket.productName = row.productName || bucket.productName;
    bucket.totalQty += row.qty;
    bucket.totalAmountCents += row.amountCents;
    bucket.members.set(row.memberId, (bucket.members.get(row.memberId) ?? 0) + 1);
  }
  return [...bySku.values()];
}

function scoreBucket(bucket: SkuBucket): { repeatMembers: number; repeatPurchases: number; score: number; txnCount: number } {
  let repeatMembers = 0;
  let repeatPurchases = 0;
  let txnCount = 0;
  for (const txns of bucket.members.values()) {
    txnCount += txns;
    if (txns >= 2) {
      repeatMembers += 1;
      repeatPurchases += txns - 1;
    }
  }
  return { repeatMembers, repeatPurchases, score: repeatMembers * repeatPurchases, txnCount };
}

/**
 * Decide every sku in `rows`. Test-member purchases are ignored, and a sku bought only by
 * test members is dropped. One member buying in bulk is dropped before the listed-sku rule,
 * so a weak pattern keeps its own reason. A sku that clears the repeat threshold is then
 * dropped when it is already on the shelf. The rest are ranked by score: the strongest is
 * escalated, the next ones are shortlisted, and anything past the daily cap is below threshold.
 */
export function classifyPurchases(
  rows: readonly LoyaltyPurchase[],
  blocked: (sku: string) => boolean = () => false,
): LoyaltyDecision[] {
  const testOnly = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.sku);
    if (!row.isTest) testOnly.delete(row.sku);
    else if (![...rows].some((other) => other.sku === row.sku && !other.isTest)) testOnly.add(row.sku);
  }

  const decisions = new Map<string, LoyaltyDecision>();
  for (const sku of testOnly) {
    const sample = rows.find((row) => row.sku === sku);
    const qty = rows.filter((row) => row.sku === sku).reduce((sum, row) => sum + row.qty, 0);
    decisions.set(sku, {
      sku,
      productName: sample?.productName ?? sku,
      distinctMembers: 0,
      repeatMembers: 0,
      repeatPurchases: 0,
      totalQty: qty,
      totalAmountSgd: sgdFromCents(rows.filter((row) => row.sku === sku).reduce((sum, row) => sum + row.amountCents, 0)),
      score: 0,
      status: "dropped",
      reason: YUU_REASON.testMembers,
    });
  }

  const eligible: LoyaltyDecision[] = [];
  for (const bucket of bucketPurchases(rows)) {
    const { repeatMembers, repeatPurchases, score, txnCount } = scoreBucket(bucket);
    const base: LoyaltyDecision = {
      sku: bucket.sku,
      productName: bucket.productName,
      distinctMembers: bucket.members.size,
      repeatMembers,
      repeatPurchases,
      totalQty: bucket.totalQty,
      totalAmountSgd: sgdFromCents(bucket.totalAmountCents),
      score,
      status: "dropped",
      reason: YUU_REASON.belowThreshold,
    };
    const bulk = bucket.members.size === 1 && (bucket.totalQty >= YUU_BULK_QTY || txnCount >= YUU_BULK_TXNS);
    if (bulk) {
      base.reason = YUU_REASON.singleMemberBulk;
    } else if (repeatMembers < YUU_MIN_REPEAT_MEMBERS || score < YUU_MIN_SCORE) {
      base.reason = YUU_REASON.belowThreshold;
    } else if (blocked(bucket.sku)) {
      base.reason = YUU_REASON.alreadyListed;
    } else {
      eligible.push(base);
      continue;
    }
    decisions.set(bucket.sku, base);
  }

  eligible.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
  eligible.forEach((decision, index) => {
    if (index === 0) {
      decision.status = "escalated";
      decision.reason = YUU_REASON.escalated;
    } else if (index < YUU_SHORTLIST_LIMIT) {
      decision.status = "shortlisted";
      decision.reason = YUU_REASON.shortlisted;
    } else {
      decision.status = "dropped";
      decision.reason = YUU_REASON.belowThreshold;
    }
    decisions.set(decision.sku, decision);
  });

  return [...decisions.values()].filter((decision) => seen.has(decision.sku)).sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
}
