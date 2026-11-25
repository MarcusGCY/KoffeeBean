import type { YuuTierName } from "./types";

/** Member under 500 points, Silver under 2000, Gold from 2000. */
export function tierForPoints(points: number): YuuTierName {
  const value = Number.isFinite(points) ? points : 0;
  if (value < 500) return "Member";
  if (value < 2000) return "Silver";
  return "Gold";
}

export function sgdFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** One point per whole Singapore dollar on the transaction, not per unit. */
export function pointsForCents(cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.floor(cents / 100);
}
