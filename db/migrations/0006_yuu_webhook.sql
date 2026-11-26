-- Delivery state for an escalated yuu signal. One row per sku, window, and Singapore day.
-- webhook_status stays when the detector recomputes the score, so a sent escalation is not posted again.
-- Idempotent. Apply with: npm run db:migrate

ALTER TABLE yuu_signals ADD COLUMN IF NOT EXISTS webhook_status TEXT;
ALTER TABLE yuu_signals ADD COLUMN IF NOT EXISTS webhook_code INTEGER;
