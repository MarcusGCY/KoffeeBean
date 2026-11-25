import { simulateYuuBurst } from "../src/lib/yuu/simulate";

/**
 * Plants the simulated yuu burst and runs the detector. Same code as the ops
 * console button. Needs DATABASE_URL and BI_HASH_SECRET. Neither is printed.
 *
 *   npm run yuu:simulate
 */

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  if ((process.env.BI_HASH_SECRET?.trim().length ?? 0) < 16) {
    console.error("BI_HASH_SECRET is not set (16+ characters).");
    process.exit(1);
  }
  const panel = await simulateYuuBurst();
  const signals = panel.signals.map((signal) => ({
    sku: signal.sku,
    productName: signal.productName,
    status: signal.status,
    score: signal.score,
    reason: signal.reason,
    distinctMembers: signal.distinctMembers,
    totalQty: signal.totalQty,
    source: signal.source,
  }));
  console.log(JSON.stringify({ ok: true, label: panel.label, windowMinutes: panel.windowMinutes, signals }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.name : "simulate failed";
  console.error(message);
  process.exit(1);
});
