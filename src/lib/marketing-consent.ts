import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { MARKETING_CONSENT_VERSION, marketingView, type MarketingConsent, type MarketingView } from "./marketing-text";

export async function readMarketing(userId: string): Promise<MarketingView> {
  return marketingView(await getAppMetadata(userId));
}

/** Records the opt-in with the wording version and time. The caller has checked the box was explicitly ticked. */
export async function grantMarketing(userId: string, now = new Date()): Promise<MarketingView> {
  const consent: MarketingConsent = { version: MARKETING_CONSENT_VERSION, consentAt: now.toISOString() };
  await patchAppMetadata(userId, { marketing_consent: consent });
  return { consented: true, consentAt: consent.consentAt, needsRenewal: false, version: consent.version };
}

/** Withdraws consent. Auth0 deletes a top-level `app_metadata` key that is patched to null. */
export async function withdrawMarketing(userId: string): Promise<MarketingView> {
  await patchAppMetadata(userId, { marketing_consent: null });
  return { consented: false, consentAt: null, needsRenewal: false, version: MARKETING_CONSENT_VERSION };
}
