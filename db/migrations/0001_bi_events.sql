-- BeanBox BI event log (Neon Postgres). Analytics only: Auth0 stays the source of
-- truth for carts and orders. Idempotent; safe to re-run:
--   psql "$DATABASE_URL" -f db/migrations/0001_bi_events.sql
--
-- No PII and no chat text. shopper_hash is an HMAC-SHA256 of the Auth0 `sub`
-- (see src/lib/bi-hash.ts). source separates real shoppers from demo/admin traffic.

CREATE TABLE IF NOT EXISTS bi_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  event_type   text        NOT NULL CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  source       text        NOT NULL CHECK (source IN ('live', 'demo')),
  shopper_hash text        NOT NULL CHECK (shopper_hash ~ '^[0-9a-f]{64}$'),
  session_id   text        NULL CHECK (session_id IS NULL OR length(session_id) <= 64),
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS bi_events_created_at_idx
  ON bi_events (created_at DESC);
CREATE INDEX IF NOT EXISTS bi_events_source_type_created_idx
  ON bi_events (source, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS bi_events_shopper_created_idx
  ON bi_events (shopper_hash, created_at DESC);

-- Append-only: rows are never edited. DELETE stays allowed for retention and for
-- purging demo traffic.
CREATE OR REPLACE FUNCTION bi_events_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bi_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bi_events_no_update ON bi_events;
CREATE TRIGGER bi_events_no_update
  BEFORE UPDATE ON bi_events
  FOR EACH ROW EXECUTE FUNCTION bi_events_reject_update();

-- Optional mirror of orders for cross-shopper aggregates (Auth0 holds the real
-- orders). One row per order; cancelled_at is set when the order is cancelled.
-- line_items is [{ "productId", "qty", "unitPriceCents" }] only.
CREATE TABLE IF NOT EXISTS bi_orders (
  order_id       text        PRIMARY KEY,
  shopper_hash   text        NOT NULL CHECK (shopper_hash ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz NOT NULL,
  cancelled_at   timestamptz NULL,
  subtotal_cents integer     NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents integer     NOT NULL CHECK (discount_cents >= 0),
  tax_cents      integer     NOT NULL CHECK (tax_cents >= 0),
  total_cents    integer     NOT NULL CHECK (total_cents >= 0),
  coupon         text        NULL,
  line_items     jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(line_items) = 'array'),
  source         text        NOT NULL CHECK (source IN ('live', 'demo')),
  recorded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bi_orders_source_created_idx
  ON bi_orders (source, created_at DESC);
CREATE INDEX IF NOT EXISTS bi_orders_shopper_idx
  ON bi_orders (shopper_hash, created_at DESC);
