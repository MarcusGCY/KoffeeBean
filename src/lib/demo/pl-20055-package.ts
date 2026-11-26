import { launchConfigSchema, type DraftPush, type LaunchConfig } from "./launch";

/**
 * Marcus-approved Step 5 package for PL-20055, kept in the repo.
 * Redis can override it. The draft push is ops preview metadata only.
 */

const GO_LIVE_AT = "2026-12-03T09:00:00+08:00";
const PROMO_ENDS_AT = "2026-12-17T23:59:59+08:00";

const config = launchConfigSchema.parse({
  sku: "PL-20055",
  title: "Pelita Wellness Magnesium Glycinate 400 mg (60 Capsules)",
  subtitle:
    "Gentle, daily magnesium glycinate capsules to support everyday muscle relaxation and evening wind-down. 60 capsules (30-day supply).",
  longCopy:
    "Formulated with chelated magnesium glycinate, this daily supplement is designed for gentle absorption and everyday wellness support. Ideal for active routines and evening wind-down, each bottle provides 60 capsules sourced from Evergreen Nutrition for Pelita's Vitamins & Supplements range.",
  bullets: [
    "Delivers 400 mg magnesium glycinate per serving in easy-to-swallow capsules",
    "Chelated glycinate form selected for gentle daily digestion",
    "Supports normal muscle function and relaxed evening routines",
    "60 capsules per bottle; take as directed on the product label with water",
  ],
  size: "60 capsules",
  category: "Vitamins & supplements",
  supplier: "Evergreen Nutrition",
  imageUrl: "/images/pelita/PL-20055.png",
  shelfPriceCents: 3290,
  promo: {
    type: "multibuy",
    label: "2 for S$55.90 · save S$9.90 while trial stock lasts",
    buyQty: 2,
    bundlePriceCents: 5590,
    startsAt: GO_LIVE_AT,
    endsAt: PROMO_ENDS_AT,
  },
  memberOffer: {
    headline: "yuu aggregates only",
    segmentLabel:
      "Repeat wellness/supplement buyers across yuu partner stores; active yuu shoppers at Harbour Mart, Ridge Pharmacy, and Eastlink Grocery.",
  },
  stores: ["Harbour Mart · 4 units", "Ridge Pharmacy · 3 units", "Eastlink Grocery · 3 units", "DC reserve · 2 units"],
  goLiveAt: GO_LIVE_AT,
  status: "scheduled",
});

const PRICE_NOTE =
  "S$32.90 incl. GST (S$30.18 ex GST). Unit cost S$17.50 ex GST / S$19.08 incl. GST. 2 for S$55.90 incl. GST is S$27.95 per unit and saves S$9.90 versus 2 × S$32.90, while trial stock lasts. Promo window: 3 Dec 2026, 9:00 AM SGT – 17 Dec 2026, 11:59 PM SGT.";

const DRAFT_PUSH: DraftPush = {
  title: "New at Pelita: Magnesium Glycinate 400 mg",
  body: "Just landed at Harbour Mart, Ridge Pharmacy & Eastlink Grocery. Grab 2 bottles for S$55.90 (U.P. S$32.90 each — save S$9.90) while trial stock lasts.",
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
