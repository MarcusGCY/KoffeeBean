-- Escalations dedupe inside the rolling detection window, not once per Singapore day.
-- 0004's UNIQUE (sku, window_minutes, window_day) kept a single row per sku per day, so a
-- later burst reused that row and its webhook_status and never posted again.
-- Drop that constraint. Keep every existing row. A burst whose previous escalated
-- detected_at is at least window_minutes old inserts a new id.
-- Idempotent. Apply with: npm run db:migrate

ALTER TABLE yuu_signals ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;

ALTER TABLE yuu_signals ALTER COLUMN detected_at SET DEFAULT now();

UPDATE yuu_signals
SET detected_at = created_at
WHERE detected_at IS NULL;

ALTER TABLE yuu_signals ALTER COLUMN detected_at SET NOT NULL;

ALTER TABLE yuu_signals DROP CONSTRAINT IF EXISTS yuu_signals_sku_window_minutes_window_day_key;

DROP INDEX IF EXISTS yuu_signals_sku_window_minutes_window_day_key;

-- Drop a uniquely-named day key too, if the inline UNIQUE was renamed. One statement so the migrator does not split it.
DO $$ DECLARE cons name; BEGIN FOR cons IN SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'yuu_signals' AND c.contype = 'u' AND pg_get_constraintdef(c.oid) LIKE '%window_day%' AND pg_get_constraintdef(c.oid) NOT LIKE '%detected_at%' LOOP EXECUTE format('ALTER TABLE yuu_signals DROP CONSTRAINT IF EXISTS %I', cons); END LOOP; END $$;

CREATE INDEX IF NOT EXISTS yuu_signals_sku_window_detected_idx
  ON yuu_signals (sku, window_minutes, detected_at DESC, id DESC);
