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
 * Which existing code may be quoted for a cart or a returning customer.
 * Empty on purpose. SAVE10 (10%), BEANS20 (20%), and WELCOME10 (10%) are valid
 * typed codes with no expiry and no cart or purchase rule. Choosing one to
 * quote is a business decision this file does not make.
 */
export const ACTIVE_COUPON_OFFER_POLICY: readonly CouponOfferRule[] = Object.freeze([]);

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
  const base = {
    cartHasItems,
    returningCustomer,
    completedPurchases: facts.completedPurchases,
    discountAlreadyApplied: facts.discountAlreadyApplied,
  };
  if (!facts.ok || cartHasItems == null || returningCustomer == null) {
    return { history: "unavailable", ...base, offer: null, reason: "unavailable" };
  }
  if (!cartHasItems && !returningCustomer) {
    return { history: "ok", ...base, offer: null, reason: "not_eligible" };
  }
  const matched = policy.filter((rule) => (rule.when === "cart" && cartHasItems) || (rule.when === "returning" && returningCustomer));
  const offer = quote(matched);
  if (!offer) return { history: "ok", ...base, offer: null, reason: "no_eligible_offer" };
  return { history: "ok", ...base, offer, reason: "eligible" };
}
