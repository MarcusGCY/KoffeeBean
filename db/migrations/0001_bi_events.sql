-- BeanBox BI event log (Neon Postgres, project KoffeeBean-BI, database koffeebean_bi). Analytics only: Auth0
-- stays the source of truth for carts and orders. This file mirrors the shape already
-- applied on the Neon `main` branch. Idempotent; safe to re-run:
--   psql "$DATABASE_URL" -f db/migrations/0001_bi_events.sql
--
-- No PII and no chat text. shopper_hash is an HMAC-SHA256 of the Auth0 `sub`
-- (see src/lib/bi-hash.ts). source is 'live' for real shopper traffic and 'demo'
-- only for the explicit demo seed. BI queries exclude 'demo' by default.
-- bi_events is append-only by convention: the
-- app only inserts.

CREATE TABLE IF NOT EXISTS bi_events (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type   TEXT        NOT NULL,
  source       TEXT        NOT NULL CHECK (source IN ('live', 'demo')),
  shopper_hash TEXT        NOT NULL,
  session_id   TEXT        NULL,
  payload      JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS bi_events_created_at_idx
  ON bi_events (created_at DESC);
CREATE INDEX IF NOT EXISTS bi_events_type_source_created_idx
  ON bi_events (event_type, source, created_at DESC);
CREATE INDEX IF NOT EXISTS bi_events_shopper_created_idx
  ON bi_events (shopper_hash, created_at DESC);

-- Optional mirror of orders for cross-shopper aggregates (Auth0 holds the real
-- orders). items is [{ "productId", "qty", "unitPriceCents" }] only.
-- attributed_sku_ids lists SKUs credited to a recommendation.
CREATE TABLE IF NOT EXISTS bi_orders (
  order_id           TEXT        PRIMARY KEY,
  shopper_hash       TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  cancelled_at       TIMESTAMPTZ NULL,
  subtotal_cents     INTEGER     NOT NULL,
  discount_cents     INTEGER     NOT NULL,
  tax_cents          INTEGER     NOT NULL,
  total_cents        INTEGER     NOT NULL,
  coupon             TEXT        NULL,
  items              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source             TEXT        NOT NULL CHECK (source IN ('live', 'demo')),
  attributed_sku_ids TEXT[]      NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS bi_orders_created_at_idx
  ON bi_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS bi_orders_source_created_idx
  ON bi_orders (source, created_at DESC);
