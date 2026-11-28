import { launchConfigSchema, type DraftPush, type LaunchConfig, type LaunchSignalMeta } from "./launch";

/**
 * Signal 107 package for PL-20068 (Zinc 25 mg, 60 Tablets), kept in the repo.
 * Automated DFI Operation Team handoff. Evergreen Nutrition / Pelita ERP row 6.
 * Redis can override it. The draft push is ops preview metadata only and is never sent.
 * The packshot at /images/pelita/PL-20068.png is illustrative Pelita Wellness packaging, not supplier photography.
 */

/** Ops-only handoff identity. Shoppers never see it. */
export const PL20068_SIGNAL: LaunchSignalMeta = {
  id: 107,
  label: "Signal 107",
  handoff: "automated DFI Operation Team handoff",
  supplier: "Evergreen Nutrition",
  erp: "Pelita ERP",
  erpRow: 6,
};

/** Ops-only ranging, in units. Shoppers only see the Eastlink Grocery pill. */
export const PL20068_RANGING = {
  "eastlink-grocery": 10,
  "dc-reserve": 2,
  "harbour-mart": 0,
  "ridge-pharmacy": 0,
  "pelita-sg": 0,
  "northshore-wellness": 0,
  online: 0,
} as const;

/** Ops-only economics in cents. Promo is retailer-funded: no supplier promo support. */
export const PL20068_ECONOMICS = {
  gstPct: 9,
  unitCostExGstCents: 860,
  unitCostInclGstCents: 937,
  regular: { inclGstCents: 1490, exGstCents: 1367, gpCents: 507, gpPct: 37.1 },
  promo: { inclGstCents: 1290, exGstCents: 1183, gpCents: 323, gpPct: 27.3, limitPerMember: 2, supplierFunded: false },
} as const;

const GO_LIVE_AT = "2026-12-04T09:00:00+08:00";
const PROMO_ENDS_AT = "2026-12-18T23:59:59+08:00";

const config = launchConfigSchema.parse({
  sku: "PL-20068",
  title: "Zinc 25 mg, 60 Tablets",
  subtitle: "A daily zinc tablet from Evergreen Nutrition. 25 mg per tablet, 60 tablets per bottle.",
  longCopy:
    "Zinc 25 mg in an easy one-a-day tablet. Now at Eastlink Grocery. yuu members get an intro price of S$12.90 (usual S$14.90), 4 to 18 Dec, limit 2 per member.",
  bullets: ["25 mg zinc per tablet", "60 tablets per bottle", "Take as directed on the label"],
  size: "60 Tablets",
  category: "Vitamins & Supplements",
  supplier: "Evergreen Nutrition",
  imageUrl: "/images/pelita/PL-20068.png",
  shelfPriceCents: 1490,
  promo: {
    type: "member_price",
    label: "yuu Member Intro Price S$12.90 · usual S$14.90 · limit 2 per member",
    memberPriceCents: 1290,
    startsAt: GO_LIVE_AT,
    endsAt: PROMO_ENDS_AT,
  },
  memberOffer: {
    headline: "yuu Member Intro Price",
    memberPriceCents: 1290,
    segmentLabel:
      "Eastlink repeat minerals buyers (zinc and magnesium pool), plus PL-20055 magnesium buyers at Eastlink as a cross-sell segment. yuu aggregates only, zero PII.",
  },
  stores: ["Eastlink Grocery · 10 units"],
  goLiveAt: GO_LIVE_AT,
  status: "scheduled",
});

const PRICE_NOTE =
  "S$14.90 incl. 9% GST (S$13.67 ex GST). yuu Member Intro Price S$12.90 incl. 9% GST (S$11.83 ex GST), S$2.00 off the usual price. Limit 2 per yuu member. Promo window: 4 Dec 2026, 9:00 AM SGT – 18 Dec 2026, 11:59 PM SGT.";

const DRAFT_PUSH: DraftPush = {
  title: "New at Eastlink Grocery: Zinc 25 mg, 60 tablets",
  body: "yuu intro price S$12.90 (usual S$14.90), 4–18 Dec. Limit 2 per member.",
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

/** True for this package, including after Go live now flips the status. */
export function isApprovedPl20068(value: LaunchConfig): boolean {
  return value.sku === config.sku && value.title === config.title && value.shelfPriceCents === config.shelfPriceCents && value.goLiveAt === config.goLiveAt;
}

export function packagePriceNote(value: LaunchConfig): string | null {
  return isApprovedPl20068(value) ? PRICE_NOTE : null;
}

export function scheduleExtras(value: LaunchConfig): {
  draftPush: DraftPush | null;
  priceNote: string | null;
  signal: LaunchSignalMeta | null;
} {
  if (!isApprovedPl20068(value)) return { draftPush: null, priceNote: null, signal: null };
  return { draftPush: DRAFT_PUSH, priceNote: PRICE_NOTE, signal: PL20068_SIGNAL };
}
