-- BeanBox BI customer profiles: one row per shopper hash with coarse, aggregate-friendly traits for the BI bot.
-- Analytics only: Auth0 stays the source of truth for orders and consent. WRITTEN, NOT APPLIED. Nothing in
-- the app or the tests runs this file. Apply deliberately, to a branch first, and review the result:
--   psql "$DATABASE_URL" -f db/migrations/0003_bi_customer_profiles.sql
-- Idempotent; safe to re-run. It does not depend on 0002 (is_test is defined on this table itself). The app
-- swallows write errors, so shopper flows keep working before and after this is applied.
--
-- Privacy (PDPA):
--   * shopper_hash is the same keyed HMAC-SHA256 of the Auth0 `sub` used by bi_events (src/lib/bi-hash.ts).
--     No sub, name, email or chat text.
--   * region is only ever the first two digits of a Singapore postcode (the postal district), and only for
--     a shopper who opted in to location use. A postcode is never stored here; the CHECK enforces the shape.
--   * marketing_consent mirrors the shopper's own, separate opt-in held in Auth0. consent_at is present only
--     while consent is given. A withdrawal sets marketing_consent = false and consent_at = NULL.
--   * is_test rows (QA and demo shoppers, from the single isTestShopper helper) are kept but flagged so BI
--     excludes them from aggregates.
--
-- Column notes:
--   segment         'prospect' (no order), 'new' (one order ever), 'repeat' (more than one), 'lapsed' (none in 90 days).
--   cadence_days    typical days between bean orders, NULL until two. NULL when personalization is off.
--   aov_cents       average total of non-cancelled orders in the last 90 days, NULL if none.
--   orders_90d      non-cancelled orders in the last 90 days.
--   preferred_roast most bought roast, NULL if unknown. NULL when personalization is off.

CREATE TABLE IF NOT EXISTS bi_customer_profiles (
  shopper_hash      TEXT        PRIMARY KEY,
  segment           TEXT        NOT NULL CHECK (segment IN ('prospect', 'new', 'repeat', 'lapsed')),
  cadence_days      INTEGER     NULL CHECK (cadence_days IS NULL OR cadence_days > 0),
  aov_cents         INTEGER     NULL CHECK (aov_cents IS NULL OR aov_cents >= 0),
  orders_90d        INTEGER     NOT NULL DEFAULT 0 CHECK (orders_90d >= 0),
  preferred_roast   TEXT        NULL CHECK (preferred_roast IS NULL OR preferred_roast IN ('light', 'medium', 'medium-dark', 'dark')),
  region            TEXT        NULL CHECK (region IS NULL OR region ~ '^\d{2}$'),
  is_test           BOOLEAN     NOT NULL DEFAULT false,
  marketing_consent BOOLEAN     NOT NULL DEFAULT false,
  consent_at        TIMESTAMPTZ NULL,
  source            TEXT        NOT NULL CHECK (source IN ('live', 'demo')),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT marketing_consent OR consent_at IS NOT NULL),
  CHECK (marketing_consent OR consent_at IS NULL)
);

CREATE INDEX IF NOT EXISTS bi_customer_profiles_source_test_idx
  ON bi_customer_profiles (source, is_test);
CREATE INDEX IF NOT EXISTS bi_customer_profiles_marketing_idx
  ON bi_customer_profiles (marketing_consent, updated_at DESC)
  WHERE marketing_consent;
