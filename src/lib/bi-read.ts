import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { biDbConfigured, getBiSql, type BiSql } from "./bi-db";
import { BI_EVENT_TYPES, isBiEventType, type BiEventType } from "./bi-events";

/**
 * Read side of the BI event log, for the Marcus-facing BI bot. Service-token auth
 * only (`BI_API_SECRET`); the Auth0 shopper session is never consulted. Rows are
 * selected by explicit column list and only `shopper_hash` identifies a shopper.
 */

export const BI_EVENTS_DEFAULT_LIMIT = 50;
export const BI_EVENTS_MAX_LIMIT = 200;
export const BI_SUMMARY_DEFAULT_DAYS = 7;
export const BI_TOP_SKUS = 10;
export const BI_TOP_COUPONS = 10;

export type BiReadSource = "live" | "demo" | "all";

const NO_STORE = { "cache-control": "private, no-store" };

export function biJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function secretMatches(provided: string, secret: string): boolean {
  const got = createHash("sha256").update(provided).digest();
  const want = createHash("sha256").update(secret).digest();
  return timingSafeEqual(got, want);
}

function presentedSecret(req: Request): string {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (bearer?.[1]) return bearer[1];
  return (req.headers.get("x-bi-secret") ?? "").trim();
}

/** Null when the caller holds `BI_API_SECRET`; otherwise the 503 or 401 response to return. */
export function requireBiSecret(req: Request): NextResponse | null {
  const secret = process.env.BI_API_SECRET?.trim() ?? "";
  if (!secret) return biJson({ error: "unconfigured" }, 503);
  const provided = presentedSecret(req);
  if (!provided || !secretMatches(provided, secret)) return biJson({ error: "unauthorized" }, 401);
  return null;
}

/** The Neon query function, or the 503 response when `DATABASE_URL` is unset. */
export function requireBiSql(): BiSql | NextResponse {
  const sql = biDbConfigured() ? getBiSql() : null;
  return sql ?? biJson({ error: "database_unconfigured" }, 503);
}

export class BiQueryError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseTime(name: string, value: string | null): Date | undefined {
  if (value === null || value.trim() === "") return undefined;
  const text = value.trim();
  const date = ISO.test(text) ? new Date(text) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new BiQueryError(`${name} must be an ISO 8601 timestamp`);
  return date;
}

function parseSource(params: URLSearchParams): BiReadSource {
  const raw = params.get("source")?.trim().toLowerCase();
  if (!raw) return "live";
  if (raw === "live" || raw === "demo" || raw === "all") return raw;
  throw new BiQueryError("source must be live, demo, or all");
}

function parseEventTypes(params: URLSearchParams): BiEventType[] {
  const types = params
    .getAll("event_type")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  for (const type of types) {
    if (!isBiEventType(type)) throw new BiQueryError(`unknown event_type; expected one of ${BI_EVENT_TYPES.join(", ")}`);
  }
  return [...new Set(types)] as BiEventType[];
}

function parseLimit(value: string | null): number {
  if (value === null || value.trim() === "") return BI_EVENTS_DEFAULT_LIMIT;
  if (!/^\d{1,9}$/.test(value.trim())) throw new BiQueryError("limit must be a positive integer");
  const n = Number(value);
  if (n < 1) throw new BiQueryError("limit must be a positive integer");
  return Math.min(n, BI_EVENTS_MAX_LIMIT);
}

function parseCursor(params: URLSearchParams): string | undefined {
  const raw = (params.get("cursor") ?? params.get("after_id") ?? "").trim();
  if (!raw) return undefined;
  if (!/^\d{1,18}$/.test(raw)) throw new BiQueryError("cursor must be an event id from nextCursor");
  return raw;
}

type Filters = { clauses: string[]; values: unknown[] };

function windowFilters(since: Date | undefined, until: Date | undefined, source: BiReadSource, types: BiEventType[]): Filters {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (clause: (placeholder: string) => string, value: unknown) => {
    values.push(value);
    clauses.push(clause(`$${values.length}`));
  };
  if (since) add((p) => `created_at >= ${p}::timestamptz`, since.toISOString());
  if (until) add((p) => `created_at < ${p}::timestamptz`, until.toISOString());
  if (source !== "all") add((p) => `source = ${p}`, source);
  if (types.length) add((p) => `event_type = ANY(${p}::text[])`, types);
  return { clauses, values };
}

export type BiEventsQuery = {
  since?: Date;
  until?: Date;
  source: BiReadSource;
  eventTypes: BiEventType[];
  limit: number;
  cursor?: string;
};

/** Throws `BiQueryError` (a 400) on any bad parameter. */
export function parseEventsQuery(params: URLSearchParams): BiEventsQuery {
  const since = parseTime("since", params.get("since"));
  const until = parseTime("until", params.get("until"));
  if (since && until && since >= until) throw new BiQueryError("since must be before until");
  return {
    since,
    until,
    source: parseSource(params),
    eventTypes: parseEventTypes(params),
    limit: parseLimit(params.get("limit")),
    cursor: parseCursor(params),
  };
}

export type BiEventOut = {
  id: string;
  created_at: string;
  event_type: string;
  source: string;
  shopper_hash: string;
  session_id: string | null;
  payload: Record<string, unknown>;
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** Newest first. `nextCursor` is the last returned id; pass it back as `cursor`. */
export async function listBiEvents(
  sql: BiSql,
  query: BiEventsQuery,
): Promise<{ events: BiEventOut[]; nextCursor?: string }> {
  const { clauses, values } = windowFilters(query.since, query.until, query.source, query.eventTypes);
  if (query.cursor) {
    values.push(query.cursor);
    clauses.push(`id < $${values.length}::bigint`);
  }
  values.push(query.limit + 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const text = `SELECT id, created_at, event_type, source, shopper_hash, session_id, payload
    FROM bi_events ${where} ORDER BY id DESC LIMIT $${values.length}`;
  const rows = (await sql.query(text, values)) as Record<string, unknown>[];
  const page = rows.slice(0, query.limit);
  const events = page.map((row) => ({
    id: String(row.id),
    created_at: iso(row.created_at),
    event_type: String(row.event_type),
    source: String(row.source),
    shopper_hash: String(row.shopper_hash),
    session_id: row.session_id == null ? null : String(row.session_id),
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
  return rows.length > query.limit ? { events, nextCursor: events[events.length - 1]?.id } : { events };
}

export type BiSummaryQuery = { since: Date; until: Date; source: BiReadSource };

/** Defaults to the last 7 days, live traffic only. Throws `BiQueryError` on bad input. */
export function parseSummaryQuery(params: URLSearchParams, now: Date = new Date()): BiSummaryQuery {
  const until = parseTime("until", params.get("until")) ?? now;
  const since = parseTime("since", params.get("since")) ?? new Date(until.getTime() - BI_SUMMARY_DEFAULT_DAYS * 86_400_000);
  if (since >= until) throw new BiQueryError("since must be before until");
  return { since, until, source: parseSource(params) };
}

const num = (value: unknown): number => Number(value ?? 0);

export type BiSummary = {
  window: { since: string; until: string; source: BiReadSource };
  orders: {
    placed: number;
    cancelled: number;
    revenueCents: number;
    aovCents: number | null;
    withCoupon: number;
  };
  topSkus: { productId: string; qty: number; orders: number }[];
  coupons: { code: string; orders: number }[];
  recommendations: {
    shown: number;
    added: number;
    undone: number;
    shownRecommendations: number;
    addedRecommendations: number;
    conversion: number | null;
  };
  baristaTurns: { total: number; byOutcome: Record<string, number> };
};

export async function biSummary(sql: BiSql, query: BiSummaryQuery): Promise<BiSummary> {
  const base = windowFilters(query.since, query.until, query.source, []);
  const where = (extra: string) => `WHERE ${[...base.clauses, extra].join(" AND ")}`;
  const values = base.values;
  const run = (text: string) => sql.query(text, values) as Promise<Record<string, unknown>[]>;

  const [byType, orderTotals, skus, coupons] = await Promise.all([
    run(`SELECT event_type, payload->>'outcome' AS outcome, COUNT(*)::int AS n,
           COUNT(DISTINCT payload->>'recommendationId')::int AS recs
         FROM bi_events ${where("event_type IN ('order.placed','order.cancelled','barista.turn','recommend.shown','recommend.added','recommend.undone')")}
         GROUP BY event_type, payload->>'outcome'`),
    run(`SELECT COUNT(*)::int AS orders, COALESCE(SUM((payload->>'totalCents')::bigint), 0)::float8 AS revenue_cents,
           COUNT(payload->>'coupon')::int AS with_coupon
         FROM bi_events ${where("event_type = 'order.placed'")}`),
    run(`SELECT item->>'productId' AS product_id, SUM((item->>'qty')::int)::int AS qty, COUNT(DISTINCT e.id)::int AS orders
         FROM bi_events e CROSS JOIN LATERAL jsonb_array_elements(e.payload->'items') AS item
         ${where("event_type = 'order.placed'")}
         GROUP BY item->>'productId' ORDER BY qty DESC, product_id ASC LIMIT ${BI_TOP_SKUS}`),
    run(`SELECT payload->>'coupon' AS code, COUNT(*)::int AS orders
         FROM bi_events ${where("event_type = 'order.placed' AND payload->>'coupon' IS NOT NULL")}
         GROUP BY payload->>'coupon' ORDER BY orders DESC, code ASC LIMIT ${BI_TOP_COUPONS}`),
  ]);

  const count = (type: string) => byType.filter((r) => r.event_type === type).reduce((sum, r) => sum + num(r.n), 0);
  const recs = (type: string) => byType.filter((r) => r.event_type === type).reduce((sum, r) => sum + num(r.recs), 0);
  const byOutcome: Record<string, number> = {};
  for (const row of byType) {
    if (row.event_type === "barista.turn") byOutcome[String(row.outcome)] = num(row.n);
  }

  const placed = num(orderTotals[0]?.orders);
  const revenueCents = num(orderTotals[0]?.revenue_cents);
  const shownRecommendations = recs("recommend.shown");
  const addedRecommendations = recs("recommend.added");

  return {
    window: { since: query.since.toISOString(), until: query.until.toISOString(), source: query.source },
    orders: {
      placed,
      cancelled: count("order.cancelled"),
      revenueCents,
      aovCents: placed > 0 ? Math.round(revenueCents / placed) : null,
      withCoupon: num(orderTotals[0]?.with_coupon),
    },
    topSkus: skus.map((r) => ({ productId: String(r.product_id), qty: num(r.qty), orders: num(r.orders) })),
    coupons: coupons.map((r) => ({ code: String(r.code), orders: num(r.orders) })),
    recommendations: {
      shown: count("recommend.shown"),
      added: count("recommend.added"),
      undone: count("recommend.undone"),
      shownRecommendations,
      addedRecommendations,
      conversion: shownRecommendations > 0 ? addedRecommendations / shownRecommendations : null,
    },
    baristaTurns: { total: count("barista.turn"), byOutcome },
  };
}
