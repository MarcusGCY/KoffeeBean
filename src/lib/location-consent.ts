import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { districtPatch } from "./barista-profile";
import { LOCATION_PURPOSE, districtOf, normalizeLocation, parsePostcode, type LocationConsent } from "./location-text";

export { normalizeLocation };

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
  const meta = await getAppMetadata(userId);
  await patchAppMetadata(userId, { location, ...districtPatch(meta, location.district) });
  return location;
}

/** Withdraws consent. Auth0 deletes a top-level `app_metadata` key that is patched to null. */
export async function clearLocation(userId: string): Promise<void> {
  const meta = await getAppMetadata(userId);
  await patchAppMetadata(userId, { location: null, ...districtPatch(meta, null) });
}
