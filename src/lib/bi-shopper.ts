import { biDbConfigured, getBiSql } from "./bi-db";
import { biHashConfigured, hashShopperId } from "./bi-hash";

const SQL_TIMEOUT_MS = 2000;
const ADDED_LIMIT = 200;

/**
 * Product ids this shopper added from a Barista recommendation (`recommend.added`),
 * newest first, repeats kept so callers can count them. Reads only this shopper's
 * own rows by keyed hash. Returns [] when the log is unconfigured or slow, so a
 * nudge never fails because analytics is down.
 */
export async function recommendAddedProductIds(sub: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!biDbConfigured() || !biHashConfigured()) return [];
    const sql = getBiSql();
    if (!sql) return [];
    const hash = hashShopperId(sub);
    const query = Promise.resolve(
      sql`SELECT payload->>'productId' AS product_id FROM bi_events
          WHERE shopper_hash = ${hash} AND event_type = 'recommend.added'
          ORDER BY created_at DESC LIMIT ${ADDED_LIMIT}`,
    );
    query.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), SQL_TIMEOUT_MS);
    });
    const rows = (await Promise.race([query, timeout])) as { product_id?: unknown }[];
    return rows.flatMap((row) => (typeof row.product_id === "string" && row.product_id ? [row.product_id] : []));
  } catch {
    console.error("[bi] recommend.added read failed");
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
