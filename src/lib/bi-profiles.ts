import { z } from "zod";
import type { BiSql } from "./bi-db";
import { hashShopperId } from "./bi-hash";
import { normalizeProfile, type BaristaProfile } from "./barista-profile";
import { normalizeLocation } from "./location-text";
import { ROASTS, type Roast } from "./types";

/**
 * BI customer profiles (`bi_customer_profiles`, migration 0003). One row per shopper hash with coarse
 * traits for the BI bot. Only a 2-digit region ever leaves the account: the schema below rejects anything
 * else, so a postcode cannot reach SQL even by mistake. Taste traits are left out when personalization is
 * off. The test flag comes from the one `isTestShopper` helper in `demo-shopper.ts`.
 */

export const BI_SEGMENTS = ["prospect", "new", "repeat", "lapsed"] as const;
export type BiSegment = (typeof BI_SEGMENTS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
export const BI_PROFILE_WINDOW_DAYS = 90;

export type BiProfileFacts = {
  segment: BiSegment;
  cadenceDays: number | null;
  aovCents: number | null;
  orders90d: number;
  preferredRoast: Roast | null;
  /** First two digits of the postcode, only with location consent. */
  region: string | null;
  isTest: boolean;
  marketingConsent: boolean;
  consentAt: string | null;
};

/** The write contract. Mirrors the CHECK constraints in migration 0003. */
export const biProfileSchema = z
  .strictObject({
    segment: z.enum(BI_SEGMENTS),
    cadenceDays: z.number().int().min(1).max(365).nullable(),
    aovCents: z.number().int().min(0).max(100_000_000).nullable(),
    orders90d: z.number().int().min(0).max(10_000),
    preferredRoast: z.enum(ROASTS).nullable(),
    region: z.string().regex(/^\d{2}$/).nullable(),
    isTest: z.boolean(),
    marketingConsent: z.boolean(),
    consentAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))).nullable(),
  })
  .refine((facts) => (facts.marketingConsent ? facts.consentAt !== null : facts.consentAt === null), {
    message: "consent_at must be present exactly when marketing_consent is true",
  });

export type BiOrderFacts = { createdAt: string; cancelledAt?: string | null; totalCents: number };

export type BiProfileInput = {
  orders: readonly BiOrderFacts[];
  /** The stored `barista_profile`, or null. An `off` profile means personalization is off. */
  profile: BaristaProfile | null;
  /** The 2-digit district from an active location consent, or null. */
  region: string | null;
  marketing: { consent: boolean; at: string | null };
  isTest: boolean;
  now: Date;
};

export function segmentFor(lifetimeOrders: number, orders90d: number): BiSegment {
  if (lifetimeOrders === 0) return "prospect";
  if (orders90d === 0) return "lapsed";
  return lifetimeOrders === 1 ? "new" : "repeat";
}

/** Pure: the traits to store for one shopper. Cancelled and unreadable orders are ignored. */
export function buildBiProfileFacts(input: BiProfileInput): BiProfileFacts {
  const cutoff = input.now.getTime() - BI_PROFILE_WINDOW_DAYS * DAY_MS;
  let lifetime = 0;
  const recent: number[] = [];
  for (const order of input.orders) {
    if (!order || order.cancelledAt) continue;
    const at = Date.parse(order.createdAt);
    if (Number.isNaN(at) || !Number.isFinite(order.totalCents) || order.totalCents < 0) continue;
    lifetime += 1;
    if (at >= cutoff && at <= input.now.getTime()) recent.push(order.totalCents);
  }
  const taste = input.profile && !input.profile.off ? input.profile : null;
  const consent = input.marketing.consent && input.marketing.at !== null;
  return {
    segment: segmentFor(lifetime, recent.length),
    cadenceDays: taste?.cadenceDays ?? null,
    aovCents: recent.length ? Math.round(recent.reduce((sum, cents) => sum + cents, 0) / recent.length) : null,
    orders90d: recent.length,
    preferredRoast: taste?.preferredRoast ?? null,
    region: input.region,
    isTest: input.isTest,
    marketingConsent: consent,
    consentAt: consent ? input.marketing.at : null,
  };
}

/** The facts for one shopper straight from their `app_metadata` and retained orders. */
export function biProfileFromMeta(
  meta: Record<string, unknown>,
  orders: readonly BiOrderFacts[],
  options: {
    isTest: boolean;
    now: Date;
    profile?: BaristaProfile | null;
    /** The shopper's separate marketing opt-in. Defaults to not consented. */
    marketing?: { consent: boolean; at: string | null };
  },
): BiProfileFacts {
  return buildBiProfileFacts({
    orders,
    profile: options.profile === undefined ? normalizeProfile(meta.barista_profile) : options.profile,
    region: normalizeLocation(meta.location)?.district ?? null,
    marketing: options.marketing ?? { consent: false, at: null },
    isTest: options.isTest,
    now: options.now,
  });
}

/**
 * Upserts this shopper's row. Validates first (throws on an invalid fact, writing nothing), then one
 * `INSERT ... ON CONFLICT (shopper_hash) DO UPDATE`. `sub` is hashed here and never stored.
 */
export async function upsertBiProfile(
  sql: BiSql,
  sub: string,
  source: "live" | "demo",
  facts: BiProfileFacts,
  now: Date = new Date(),
): Promise<void> {
  const checked = biProfileSchema.parse(facts);
  const hash = hashShopperId(sub);
  await sql`
    INSERT INTO bi_customer_profiles (shopper_hash, segment, cadence_days, aov_cents, orders_90d, preferred_roast,
                                      region, is_test, marketing_consent, consent_at, source, updated_at)
    VALUES (${hash}, ${checked.segment}, ${checked.cadenceDays}, ${checked.aovCents}, ${checked.orders90d},
            ${checked.preferredRoast}, ${checked.region}, ${checked.isTest}, ${checked.marketingConsent},
            ${checked.consentAt}, ${source}, ${now.toISOString()})
    ON CONFLICT (shopper_hash) DO UPDATE SET
      segment = EXCLUDED.segment,
      cadence_days = EXCLUDED.cadence_days,
      aov_cents = EXCLUDED.aov_cents,
      orders_90d = EXCLUDED.orders_90d,
      preferred_roast = EXCLUDED.preferred_roast,
      region = EXCLUDED.region,
      is_test = EXCLUDED.is_test,
      marketing_consent = EXCLUDED.marketing_consent,
      consent_at = EXCLUDED.consent_at,
      source = EXCLUDED.source,
      updated_at = EXCLUDED.updated_at`;
}
