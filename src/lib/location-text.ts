/** Location consent types and wording. Client-safe: no server imports. */

/** Stored in `app_metadata.location.purpose`, so a later purpose change is visible per consent. */
export const LOCATION_PURPOSE = "area-personalisation";

export const LOCATION_PURPOSE_TEXT =
  "Barista and BeanBox use the first two digits of your postcode (your postal district) to tailor suggestions to your area. Analytics only ever see those two digits.";

const POSTCODE = /^\d{6}$/;

/** A Singapore postcode is exactly six digits. Returns the trimmed postcode, or null. */
export function parsePostcode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return POSTCODE.test(text) ? text : null;
}

/** The postal district: the first two digits. The only part of a postcode that ever leaves the account. */
export function districtOf(postcode: string): string {
  return postcode.slice(0, 2);
}

/** `app_metadata.location`. Present only while the shopper has opted in. */
export type LocationConsent = {
  postcode: string;
  district: string;
  consentAt: string;
  purpose: string;
};

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Defensive read of `app_metadata.location`. A row without a valid postcode, a consent time, or
 * a purpose is treated as no consent. `district` is always derived from the postcode, never trusted from storage.
 */
export function normalizeLocation(value: unknown): LocationConsent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const postcode = parsePostcode(row.postcode);
  if (!postcode || !isIso(row.consentAt)) return null;
  if (typeof row.purpose !== "string" || row.purpose.trim() === "") return null;
  return { postcode, district: districtOf(postcode), consentAt: row.consentAt, purpose: row.purpose.slice(0, 64) };
}

