import type { BiSql } from "./bi-db";
import { BI_SEGMENTS } from "./bi-profiles";
import { BI_EVENTS_DEFAULT_LIMIT, BI_EVENTS_MAX_LIMIT, BiQueryError, parseSource, type BiReadSource } from "./bi-read";
import { ROASTS } from "./types";

/**
 * Read side of `bi_customer_profiles` for the BI bot (service-token auth, same as the other `/api/bi/*`
 * routes). Aggregates are the default. A per-shopper row is returned only where `marketing_consent` is true,
 * with an explicit column list, so the table's other rows can never be listed. Test rows are excluded from
 * everything and only counted in `excludedTest`. There is no postcode anywhere in the table, and the
 * output keeps `region` to exactly two digits even if a stored value were malformed.
 */

const REGION = /^\d{2}$/;
const HASH = /^[0-9a-f]{64}$/;

export type BiProfilesQuery = { source: BiReadSource; limit: number; cursor?: string };

export function parseProfilesQuery(params: URLSearchParams): BiProfilesQuery {
  const rawLimit = params.get("limit");
  let limit = BI_EVENTS_DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^\d{1,9}$/.test(rawLimit.trim()) || Number(rawLimit) < 1) throw new BiQueryError("limit must be a positive integer");
    limit = Math.min(Number(rawLimit), BI_EVENTS_MAX_LIMIT);
  }
  const rawCursor = (params.get("cursor") ?? "").trim();
  if (rawCursor && !HASH.test(rawCursor)) throw new BiQueryError("cursor must be a shopper_hash from nextCursor");
  return { source: parseSource(params), limit, ...(rawCursor ? { cursor: rawCursor } : {}) };
}

export type BiProfileRow = {
  shopper_hash: string;
  segment: string;
  cadence_days: number | null;
  aov_cents: number | null;
  orders_90d: number;
  preferred_roast: string | null;
  region: string | null;
  consent_at: string | null;
  updated_at: string;
};

export type BiProfilesResult = {
  source: BiReadSource;
  aggregates: {
    shoppers: number;
    marketingConsented: number;
    segments: Record<string, number>;
    regions: { region: string; shoppers: number }[];
    preferredRoasts: Record<string, number>;
    avgAovCents: number | null;
    avgOrders90d: number | null;
    medianCadenceDays: number | null;
  };
  /** Only shoppers with `marketing_consent = true`, never test rows. */
  rows: BiProfileRow[];
  /** Test rows left out of the aggregates and rows above. */
  excludedTest: number;
  nextCursor?: string;
};

const num = (value: unknown): number => Number(value ?? 0);
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export async function biProfiles(sql: BiSql, query: BiProfilesQuery): Promise<BiProfilesResult> {
  const sourceClause = query.source === "all" ? "" : " AND source = $1";
  const sourceValues: unknown[] = query.source === "all" ? [] : [query.source];
  const run = (text: string, values: unknown[] = sourceValues) => sql.query(text, values) as Promise<Record<string, unknown>[]>;
  const live = `WHERE is_test = false${sourceClause}`;

  const rowValues: unknown[] = [...sourceValues];
  let cursorClause = "";
  if (query.cursor) {
    rowValues.push(query.cursor);
    cursorClause = ` AND shopper_hash > $${rowValues.length}`;
  }
  rowValues.push(query.limit + 1);

  const [totals, segments, regions, roasts, excluded, rows] = await Promise.all([
    run(`SELECT COUNT(*)::int AS shoppers,
           COUNT(*) FILTER (WHERE marketing_consent)::int AS consented,
           AVG(aov_cents)::float8 AS avg_aov_cents,
           AVG(orders_90d)::float8 AS avg_orders_90d,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY cadence_days))::float8 AS median_cadence_days
         FROM bi_customer_profiles ${live}`),
    run(`SELECT segment, COUNT(*)::int AS n FROM bi_customer_profiles ${live} GROUP BY segment`),
    run(`SELECT region, COUNT(*)::int AS n FROM bi_customer_profiles ${live} AND region ~ '^\\d{2}$'
         GROUP BY region ORDER BY n DESC, region ASC LIMIT 100`),
    run(`SELECT preferred_roast, COUNT(*)::int AS n FROM bi_customer_profiles ${live} AND preferred_roast IS NOT NULL
         GROUP BY preferred_roast`),
    run(`SELECT COUNT(*)::int AS n FROM bi_customer_profiles WHERE is_test = true${sourceClause}`),
    run(
      `SELECT shopper_hash, segment, cadence_days, aov_cents, orders_90d, preferred_roast, region, marketing_consent,
              consent_at, updated_at
       FROM bi_customer_profiles ${live} AND marketing_consent = true${cursorClause}
       ORDER BY shopper_hash ASC LIMIT $${rowValues.length}`,
      rowValues,
    ),
  ]);

  const consented = rows.filter((row) => row.marketing_consent === true);
  const page = consented.slice(0, query.limit);
  const out: BiProfileRow[] = page.map((row) => ({
    shopper_hash: String(row.shopper_hash),
    segment: String(row.segment),
    cadence_days: nullableNum(row.cadence_days),
    aov_cents: nullableNum(row.aov_cents),
    orders_90d: num(row.orders_90d),
    preferred_roast: typeof row.preferred_roast === "string" && (ROASTS as readonly string[]).includes(row.preferred_roast) ? row.preferred_roast : null,
    region: typeof row.region === "string" && REGION.test(row.region) ? row.region : null,
    consent_at: row.consent_at == null ? null : iso(row.consent_at),
    updated_at: iso(row.updated_at),
  }));

  const segmentCounts: Record<string, number> = Object.fromEntries(BI_SEGMENTS.map((segment) => [segment, 0]));
  for (const row of segments) segmentCounts[String(row.segment)] = num(row.n);
  const roastCounts: Record<string, number> = {};
  for (const row of roasts) roastCounts[String(row.preferred_roast)] = num(row.n);

  const total = totals[0];
  return {
    source: query.source,
    aggregates: {
      shoppers: num(total?.shoppers),
      marketingConsented: num(total?.consented),
      segments: segmentCounts,
      regions: regions.flatMap((row) =>
        typeof row.region === "string" && REGION.test(row.region) ? [{ region: row.region, shoppers: num(row.n) }] : [],
      ),
      preferredRoasts: roastCounts,
      avgAovCents: total?.avg_aov_cents == null ? null : Math.round(Number(total.avg_aov_cents)),
      avgOrders90d: total?.avg_orders_90d == null ? null : Math.round(Number(total.avg_orders_90d) * 100) / 100,
      medianCadenceDays: total?.median_cadence_days == null ? null : Math.round(Number(total.median_cadence_days) * 10) / 10,
    },
    rows: out,
    excludedTest: num(excluded[0]?.n),
    ...(consented.length > query.limit ? { nextCursor: out[out.length - 1]?.shopper_hash } : {}),
  };
}
