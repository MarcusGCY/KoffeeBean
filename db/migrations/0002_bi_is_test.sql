-- BeanBox BI test-traffic tagging. Adds a nullable `is_test` flag so QA and synthetic
-- traffic can be told apart from real shoppers. Existing rows read as false. Idempotent;
-- apply deliberately (not run by the app or by tests):
--   psql "$DATABASE_URL" -f db/migrations/0002_bi_is_test.sql
--
-- The app writes is_test only for flagged traffic, so it keeps working before and after
-- this migration is applied.

ALTER TABLE bi_events ADD COLUMN IF NOT EXISTS is_test BOOLEAN NULL DEFAULT false;
ALTER TABLE bi_orders ADD COLUMN IF NOT EXISTS is_test BOOLEAN NULL DEFAULT false;
