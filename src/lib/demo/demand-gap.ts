import type { Scenario } from "./scenario";

export type DemandGapView = {
  id: string;
  query: string;
  windowDays: number;
  /** The headline figure, read straight from the fixture. */
  searches: number;
  /** The daily series, read straight from the fixture. */
  searchesPerDay: number[];
  /** Sum of searchesPerDay. Derived, and the fixture schema requires it to equal `searches`. */
  seriesTotal: number;
  /** Top of the sparkline's y axis. */
  chartMax: number;
  seriesStartDate: string;
  seriesEndDate: string;
  matchingProductsInStock: number;
  noPurchasePct: number;
  seriesStartLabel: string;
  seriesEndLabel: string;
};

/**
 * The only place the demand-gap numbers are read. Components take these values
 * from here and never hold their own copies, so the figures change in
 * src/data/demo-scenario.json alone. The scenario schema checks that the series
 * sums to the headline, so a fixture edit that breaks the two fails to load.
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
    chartMax: gap.chartMax,
    seriesStartDate: gap.seriesStartDate,
    seriesEndDate: gap.seriesEndDate,
    matchingProductsInStock: gap.matchingProductsInStock,
    noPurchasePct: gap.noPurchasePct,
    seriesStartLabel: gap.seriesStartLabel,
    seriesEndLabel: gap.seriesEndLabel,
  };
}
