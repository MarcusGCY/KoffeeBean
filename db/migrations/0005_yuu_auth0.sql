-- yuu purchases moved to Auth0 app_metadata.yuu. The member and transaction tables
-- no longer hold shoppers. This deletes the simulated personas and any purchases
-- that were stored here. Signals stay: they are the detector's proposal queue.
-- Idempotent; safe to re-run. Apply with: npm run db:migrate

DELETE FROM yuu_transactions;
DELETE FROM yuu_members;
