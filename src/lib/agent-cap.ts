/** Per-order spending cap choices for Barista. Client-safe: no server imports. */

export const DEFAULT_AGENT_CAP_CENTS = 6000;
export const CAP_PRESETS_CENTS = [3000, 6000, 10000] as const;
export const MIN_CAP_CENTS = 500;
export const MAX_CAP_CENTS = 50000;

export function validCap(cents: unknown): cents is number {
  return typeof cents === "number" && Number.isInteger(cents) && cents >= MIN_CAP_CENTS && cents <= MAX_CAP_CENTS;
}

/** Dollars typed into the Custom field to whole cents, or null when it is not a usable cap. */
export function parseCustomCapDollars(text: string): number | null {
  const trimmed = text.trim().replace(/^S?\$/i, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return validCap(cents) ? cents : null;
}
