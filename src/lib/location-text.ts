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
