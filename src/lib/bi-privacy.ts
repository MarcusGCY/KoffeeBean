/**
 * Small-group suppression for BI region aggregates. A postal district with fewer than this many
 * distinct shoppers is never shown on its own. Change it here, in code review, not per request.
 */
export const BI_MIN_GROUP_SIZE = 5;

export const OTHER_REGION = "other";

export type RegionCount = { region: string; shoppers: number };

export type SuppressedRegions = {
  /** Districts with at least `min` shoppers, largest first, then an `other` bucket when anything was hidden. */
  regions: RegionCount[];
  /** Districts a reader may be told about. A per-shopper row in any other district gets no region. */
  visible: Set<string>;
};

/**
 * Hides every district below `min` inside one `other` bucket. The bucket is only published when it holds at
 * least `min` shoppers; if the hidden districts add up to fewer, the smallest shown districts are folded in
 * until it does. Without that, `shoppers - sum(regions)` would equal a hidden district exactly whenever
 * every shopper has a region. If even all districts together are below `min`, nothing is published.
 */
export function suppressRegions(counts: readonly RegionCount[], min: number = BI_MIN_GROUP_SIZE): SuppressedRegions {
  const sorted = [...counts].filter((row) => row.shoppers > 0).sort((a, b) => b.shoppers - a.shoppers || a.region.localeCompare(b.region));
  const shown = sorted.filter((row) => row.shoppers >= min);
  const hidden = sorted.filter((row) => row.shoppers < min);
  let other = hidden.reduce((sum, row) => sum + row.shoppers, 0);
  if (hidden.length === 0) return { regions: shown, visible: new Set(shown.map((row) => row.region)) };

  while (other < min && shown.length > 0) other += shown.pop()!.shoppers;
  if (other < min) return { regions: [], visible: new Set() };
  return {
    regions: [...shown, { region: OTHER_REGION, shoppers: other }],
    visible: new Set(shown.map((row) => row.region)),
  };
}
