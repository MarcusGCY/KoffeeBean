import type { Scenario } from "./scenario";

export type DemandGapView = {
  id: string;
  query: string;
  windowDays: number;
  /** The headline figure, read straight from the fixture. */
  searches: number;
  /** The daily series, read straight from the fixture. */
  searchesPerDay: number[];
  /** Sum of searchesPerDay. Derived for display only, never stored. */
  seriesTotal: number;
  matchingProductsInStock: number;
  noPurchasePct: number;
  seriesStartLabel: string;
  seriesEndLabel: string;
};

/**
 * The only place the demand-gap numbers are read. Components take these values
 * from here and never hold their own copies, so the figures change in
 * src/data/demo-scenario.json alone. The headline and the series total are not
 * reconciled on purpose: that decision is still open with design.
 */
export function demandGapView(scenario: Scenario): DemandGapView {
  const gap = scenario.gap;
  return {
    id: gap.id,
    query: gap.query,
    windowDays: gap.windowDays,
    searches: gap.searches,
    searchesPerDay: [...gap.searchesPerDay],
    seriesTotal: gap.searchesPerDay.reduce((sum, n) => sum + n, 0),
    matchingProductsInStock: gap.matchingProductsInStock,
    noPurchasePct: gap.noPurchasePct,
    seriesStartLabel: gap.seriesStartLabel,
    seriesEndLabel: gap.seriesEndLabel,
  };
}
