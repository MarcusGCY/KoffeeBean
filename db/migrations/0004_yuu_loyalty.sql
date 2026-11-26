-- yuu loyalty signals for the Pelita demo. Not a real yuu programme.
-- Purchases live on Auth0 app_metadata.yuu (see 0005). These tables keep the detector's
-- signal queue. Idempotent; safe to re-run. Apply with the repo runner, which needs
-- DATABASE_URL and does not print it:
--   npm run db:migrate
--
-- Tier is not stored. The app derives it from points: Member under 500, Silver under 2000, Gold from 2000.
-- window_day is the Asia/Singapore calendar day, so a sku has one signal per window length per day.
-- yuu_members and yuu_transactions are leftover from the simulated personas. 0005 empties them.
-- bi_events purchase rows store a hash of the Auth0 sub, never the sub itself.

CREATE TABLE IF NOT EXISTS yuu_members (
  id           TEXT        PRIMARY KEY,
  display_name TEXT        NOT NULL,
  points       INTEGER     NOT NULL DEFAULT 0 CHECK (points >= 0),
  auth0_sub    TEXT        NULL UNIQUE,
  is_test      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS yuu_transactions (
  id            BIGSERIAL   PRIMARY KEY,
  member_id     TEXT        NOT NULL REFERENCES yuu_members (id),
  sku           TEXT        NOT NULL,
  product_name  TEXT        NOT NULL,
  qty           INTEGER     NOT NULL CHECK (qty > 0),
  amount_sgd    NUMERIC(12, 2) NOT NULL CHECK (amount_sgd >= 0),
  points_earned INTEGER     NOT NULL CHECK (points_earned >= 0),
  channel       TEXT        NOT NULL CHECK (channel IN ('web', 'sim')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS yuu_transactions_created_idx
  ON yuu_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS yuu_transactions_sku_created_idx
  ON yuu_transactions (sku, created_at DESC);
CREATE INDEX IF NOT EXISTS yuu_transactions_member_idx
  ON yuu_transactions (member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS yuu_signals (
  id               BIGSERIAL   PRIMARY KEY,
  sku              TEXT        NOT NULL,
  product_name     TEXT        NOT NULL,
  score            INTEGER     NOT NULL CHECK (score >= 0),
  window_minutes   INTEGER     NOT NULL CHECK (window_minutes > 0),
  distinct_members INTEGER     NOT NULL CHECK (distinct_members >= 0),
  total_qty        INTEGER     NOT NULL CHECK (total_qty >= 0),
  status           TEXT        NOT NULL CHECK (status IN ('dropped', 'shortlisted', 'escalated')),
  reason           TEXT        NULL,
  source           TEXT        NOT NULL CHECK (source IN ('detector', 'bi_bot')),
  proposal_ref     TEXT        NULL,
  window_day       DATE        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sku, window_minutes, window_day)
);

CREATE INDEX IF NOT EXISTS yuu_signals_day_status_idx
  ON yuu_signals (window_day, status, score DESC);
