import { launchConfigSchema, type DraftPush, type LaunchConfig } from "./launch";

/**
 * Marcus-approved Signal 54 package for PL-20055 (90 Capsules), kept in the repo.
 * Approved 7:38 PM SGT, 26 Nov 2026. Redis can override it.
 * The draft push is ops preview metadata only and is never sent.
 */

const GO_LIVE_AT = "2026-12-09T09:00:00+08:00";
const PROMO_ENDS_AT = "2026-12-23T23:59:59+08:00";

const config = launchConfigSchema.parse({
  sku: "PL-20055",
  title: "Pelita Wellness Magnesium Glycinate 400 mg (90 Capsules)",
  subtitle:
    "Gentle, daily magnesium glycinate capsules to support everyday muscle relaxation and evening wind-down. 90 capsules (45-day supply).",
  longCopy:
    "Formulated with chelated magnesium glycinate, this daily supplement is designed for gentle absorption and everyday wellness support. Ideal for active routines and evening wind-down, each bottle provides 90 capsules sourced from Evergreen Nutrition for Pelita's Vitamins & Supplements range.",
  bullets: [
    "Delivers 400 mg magnesium glycinate per serving in easy-to-swallow capsules",
    "Chelated glycinate form selected for gentle daily digestion",
    "Supports normal muscle function and relaxed evening routines",
    "90 capsules per bottle; take as directed on the product label with water",
  ],
  size: "90 Capsules",
  category: "Vitamins & Supplements",
  supplier: "Evergreen Nutrition",
  imageUrl: "/images/pelita/PL-20055.png",
  shelfPriceCents: 3290,
  promo: {
    type: "member_price",
    label: "yuu Member Intro Price S$29.90 · U.P. S$32.90 · limit 1 per member",
    memberPriceCents: 2990,
    startsAt: GO_LIVE_AT,
    endsAt: PROMO_ENDS_AT,
  },
  memberOffer: {
    headline: "yuu Member Intro Price",
    memberPriceCents: 2990,
    segmentLabel:
      "Repeat wellness and supplement buyers at Ridge Pharmacy, Harbour Mart, and Eastlink Grocery, plus broader repeat wellness yuu members (scoped to the 3 stocked stores). yuu aggregates only, zero PII.",
  },
  stores: [
    "Ridge Pharmacy · 4 units",
    "Harbour Mart · 3 units",
    "Eastlink Grocery · 3 units",
    "DC reserve · 2 units",
    "Pelita Singapore · 0 units",
    "Northshore Wellness · 0 units",
    "Online · 0 units",
  ],
  goLiveAt: GO_LIVE_AT,
  status: "scheduled",
});

const PRICE_NOTE =
  "S$32.90 incl. 9% GST (S$30.18 ex GST). yuu Member Intro Price S$29.90 incl. 9% GST (S$27.43 ex GST), S$3.00 off the U.P. Limit 1 bottle per yuu member while trial stock lasts. Promo window: 9 Dec 2026, 9:00 AM SGT – 23 Dec 2026, 11:59 PM SGT.";

const DRAFT_PUSH: DraftPush = {
  title: "New at Pelita: Magnesium Glycinate 400 mg (90 Capsules)",
  body: "Coming to Ridge Pharmacy, Harbour Mart & Eastlink Grocery. Enjoy our yuu member intro price of S$29.90 (U.P. S$32.90, limit 1 per member) while trial stock lasts.",
};

function clone(value: LaunchConfig): LaunchConfig {
  return structuredClone(value);
}

export function builtinLaunches(): LaunchConfig[] {
  return [clone(config)];
}

export function builtinLaunch(sku: string): LaunchConfig | null {
  return sku === config.sku ? clone(config) : null;
}

/** True for this approved package, including after Go live now flips the status. */
export function isApprovedPl20055(value: LaunchConfig): boolean {
  return value.sku === config.sku && value.title === config.title && value.shelfPriceCents === config.shelfPriceCents && value.goLiveAt === config.goLiveAt;
}

export function packagePriceNote(value: LaunchConfig): string | null {
  return isApprovedPl20055(value) ? PRICE_NOTE : null;
}

export function scheduleExtras(value: LaunchConfig): { draftPush: DraftPush | null; priceNote: string | null } {
  if (!isApprovedPl20055(value)) return { draftPush: null, priceNote: null };
  return { draftPush: DRAFT_PUSH, priceNote: PRICE_NOTE };
}
