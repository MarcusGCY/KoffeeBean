import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { LOCATION_PURPOSE, districtOf, parsePostcode, type LocationConsent } from "./location-text";

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

export async function readLocation(userId: string): Promise<LocationConsent | null> {
  return normalizeLocation((await getAppMetadata(userId)).location);
}

/** Records the opt-in. The caller has already checked that the shopper explicitly ticked the box. */
export async function grantLocation(userId: string, postcode: string, now = new Date()): Promise<LocationConsent> {
  const valid = parsePostcode(postcode);
  if (!valid) throw new Error("invalid_postcode");
  const location: LocationConsent = {
    postcode: valid,
    district: districtOf(valid),
    consentAt: now.toISOString(),
    purpose: LOCATION_PURPOSE,
  };
  await patchAppMetadata(userId, { location });
  return location;
}

/** Withdraws consent. Auth0 deletes a top-level `app_metadata` key that is patched to null. */
export async function clearLocation(userId: string): Promise<void> {
  await patchAppMetadata(userId, { location: null });
}
