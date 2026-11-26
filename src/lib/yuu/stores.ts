/**
 * Simulated yuu stores. Names are generic on purpose: this is not the real yuu network
 * and not a real retailer brand. Safe to import from client components.
 */

export type YuuStore = { id: string; name: string };

export const YUU_STORES: readonly YuuStore[] = [
  { id: "pelita-sg", name: "Pelita Singapore" },
  { id: "harbour-mart", name: "Harbour Mart" },
  { id: "ridge-pharmacy", name: "Ridge Pharmacy" },
  { id: "eastlink-grocery", name: "Eastlink Grocery" },
  { id: "northshore-wellness", name: "Northshore Wellness" },
];

/** Purchases written before store_id existed, and Pelita-shelf buys. */
export const YUU_DEFAULT_STORE_ID = "pelita-sg";

/** Selected by default on the partner shelf so a buy is not silently attributed to Pelita. */
export const YUU_PARTNER_DEFAULT_STORE_ID = "harbour-mart";

const IDS = new Set(YUU_STORES.map((store) => store.id));

export function isYuuStoreId(id: string): boolean {
  return IDS.has(id);
}

export function yuuStoreId(value: unknown): string {
  return typeof value === "string" && IDS.has(value) ? value : YUU_DEFAULT_STORE_ID;
}
