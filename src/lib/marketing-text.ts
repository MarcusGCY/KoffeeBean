/** Marketing consent types and wording. Client-safe: no server imports. */

/** Bump when the wording or purpose changes. A consent given under an older version no longer counts. */
export const MARKETING_CONSENT_VERSION = "2026-11-v1";

export const MARKETING_TEXT =
  "BeanBox may use your order habits (how often you buy, your usual roast and order size, and your postal district if you shared it) to send you offers and reminders. This is separate from personalization and from your area.";

/** `app_metadata.marketing_consent`. Present only while the shopper has opted in; withdrawal removes it. */
export type MarketingConsent = { version: string; consentAt: string };

const VERSION = /^[A-Za-z0-9._-]{1,32}$/;

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Defensive read. A row without a valid version and consent time is no consent. */
export function normalizeMarketing(value: unknown): MarketingConsent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.version !== "string" || !VERSION.test(row.version) || !isIso(row.consentAt)) return null;
  return { version: row.version, consentAt: row.consentAt };
}

export type MarketingView = {
  consented: boolean;
  consentAt: string | null;
  /** The shopper consented under older wording and must opt in again. */
  needsRenewal: boolean;
  version: string;
};

export function marketingView(meta: Record<string, unknown>): MarketingView {
  const stored = normalizeMarketing(meta.marketing_consent);
  const current = stored?.version === MARKETING_CONSENT_VERSION;
  return {
    consented: Boolean(stored && current),
    consentAt: stored && current ? stored.consentAt : null,
    needsRenewal: Boolean(stored && !current),
    version: MARKETING_CONSENT_VERSION,
  };
}

/** The consent as mirrored to BI: true only for the current version. */
export function marketingOf(meta: Record<string, unknown>): { consent: boolean; at: string | null } {
  const view = marketingView(meta);
  return { consent: view.consented, at: view.consentAt };
}
