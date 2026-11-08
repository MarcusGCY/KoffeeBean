import { findCoupon } from "./coupons";

/**
 * Facts read from one shopper's Auth0 `app_metadata`. Counts only.
 * `ok: false` means the cart or the order list could not be classified.
 * A missing key is an empty account (`ok: true` and zero), not a failed read.
 */
export type CommerceFacts =
  | { ok: true; cartItemCount: number; completedPurchases: number; discountAlreadyApplied: boolean }
  | { ok: false; cartItemCount: number | null; completedPurchases: number | null; discountAlreadyApplied: boolean | null };

export type CouponOfferRule = { when: "cart" | "returning"; code: string };

/**
 * Newest orders kept on the shopper's Auth0 `orders` key. `placeOrder` drops
 * anything older. A purchase past this window is not visible and is not proof
 * that the shopper has no prior purchase.
 */
export const ORDER_HISTORY_LIMIT = 20;

/**
 * SAVE10 for a nonempty cart or a verified prior purchase. The percent, the
 * subtotal base, and the lack of an expiry come from the catalog entry.
 */
export const ACTIVE_COUPON_OFFER_POLICY: readonly CouponOfferRule[] = Object.freeze([
  { when: "cart", code: "SAVE10" },
  { when: "returning", code: "SAVE10" },
]);

export type QuotedCoupon = {
  code: string;
  percentOff: number;
  appliesTo: "subtotal";
  expiresAt: null;
  terms: string;
};

export type CouponOfferView = {
  history: "ok" | "unavailable";
  cartHasItems: boolean | null;
  returningCustomer: boolean | null;
  completedPurchases: number | null;
  /** Newest orders still stored. Older checkouts are outside this window. */
  retainedOrderLimit: number;
  discountAlreadyApplied: boolean | null;
  offer: QuotedCoupon | null;
  reason: "eligible" | "not_eligible" | "no_eligible_offer" | "unavailable";
};

function termsFor(percentOff: number): string {
  return `${percentOff}% off the cart subtotal. No expiry is on file. Asking does not apply this code.`;
}

function quote(rules: readonly CouponOfferRule[]): QuotedCoupon | null {
  if (rules.length === 0) return null;
  const codes = new Set<string>();
  for (const rule of rules) {
    const coupon = findCoupon(rule.code);
    if (!coupon) return null;
    codes.add(coupon.code);
  }
  if (codes.size !== 1) return null;
  const coupon = findCoupon([...codes][0] ?? "");
  if (!coupon) return null;
  return {
    code: coupon.code,
    percentOff: coupon.percentOff,
    appliesTo: "subtotal",
    expiresAt: null,
    terms: termsFor(coupon.percentOff),
  };
}

/** Maps account facts to at most one catalog coupon. Policy percents are ignored. */
export function resolveCouponOffer(
  facts: CommerceFacts,
  policy: readonly CouponOfferRule[] = ACTIVE_COUPON_OFFER_POLICY,
): CouponOfferView {
  const cartHasItems = facts.cartItemCount == null ? null : facts.cartItemCount > 0;
  const returningCustomer = facts.completedPurchases == null ? null : facts.completedPurchases > 0;
  const history: CouponOfferView["history"] = facts.completedPurchases == null ? "unavailable" : "ok";
  const base = {
    history,
    cartHasItems,
    returningCustomer,
    completedPurchases: facts.completedPurchases,
    retainedOrderLimit: ORDER_HISTORY_LIMIT,
    discountAlreadyApplied: facts.discountAlreadyApplied,
  };
  const cartQualifies = cartHasItems === true;
  const purchaseQualifies = returningCustomer === true;
  if (!cartQualifies && !purchaseQualifies) {
    if (cartHasItems == null || returningCustomer == null) return { ...base, offer: null, reason: "unavailable" };
    return { ...base, offer: null, reason: "not_eligible" };
  }
  const matched = policy.filter(
    (rule) => (rule.when === "cart" && cartQualifies) || (rule.when === "returning" && purchaseQualifies),
  );
  const offer = quote(matched);
  if (!offer) return { ...base, offer: null, reason: "no_eligible_offer" };
  return { ...base, offer, reason: "eligible" };
}
