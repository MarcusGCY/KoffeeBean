import { biDbConfigured } from "@/lib/bi-db";
import { biHashConfigured } from "@/lib/bi-hash";
import { loadScenario } from "@/lib/demo/scenario";
import { catalogueOffer, ensurePersonas, readYuuPanel, runYuuDetector, shapePurchase, writePurchases, YuuUnconfiguredError, type PurchaseWrite } from "./db";
import { findPersona } from "./personas";
import type { YuuPanel } from "./types";

/** The six personas who repeat-buy the demand-gap sku. */
const STRONG_IDS = [
  "sim-aisha-rahman",
  "sim-benjamin-tan",
  "sim-cheryl-lim",
  "sim-danial-wong",
  "sim-eileen-koh",
  "sim-farhan-ahmad",
] as const;

const BULK_ID = "sim-harpreet-singh";
const BLIP_IDS = ["sim-grace-ng", "sim-harpreet-singh"] as const;

/** Listed, not the demand-gap product, so a weak pattern is dropped for its own reason. */
const BULK_SKU = "PL-80014";
const BLIP_SKU = "PL-80027";

export type BurstLine = {
  memberId: string;
  sku: string;
  qty: number;
  times: number;
  role: "strong" | "bulk" | "blip";
};

/** The deterministic burst: one strong repeat trend and two weak patterns. */
export function burstLines(): BurstLine[] {
  const strong = loadScenario().proposal.productId;
  return [
    ...STRONG_IDS.map((memberId): BurstLine => ({ memberId, sku: strong, qty: 1, times: 2, role: "strong" })),
    { memberId: BULK_ID, sku: BULK_SKU, qty: 12, times: 1, role: "bulk" },
    ...BLIP_IDS.map((memberId): BurstLine => ({ memberId, sku: BLIP_SKU, qty: 1, times: 2, role: "blip" })),
  ];
}

/** Expands the burst into the rows `writePurchases` inserts for a storefront buy as well. */
export function burstPurchases(): PurchaseWrite[] {
  const rows: PurchaseWrite[] = [];
  for (const line of burstLines()) {
    const found = findPersona(line.memberId);
    if (!found || !catalogueOffer(line.sku)) throw new YuuUnconfiguredError();
    const shaped = shapePurchase({
      member: { id: found.id, displayName: found.displayName, points: 0, auth0Sub: null, isTest: false },
      sku: line.sku,
      qty: line.qty,
      channel: "sim",
    });
    for (let n = 0; n < line.times; n += 1) rows.push(shaped);
  }
  return rows;
}

/**
 * Plants the burst with the same writer the storefront purchase uses, then runs the detector.
 * A single storefront purchase runs the detector immediately after its own insert.
 */
export async function simulateYuuBurst(): Promise<YuuPanel> {
  if (!biDbConfigured() || !biHashConfigured()) throw new YuuUnconfiguredError();
  await ensurePersonas();
  await writePurchases(burstPurchases());
  await runYuuDetector();
  return readYuuPanel();
}
