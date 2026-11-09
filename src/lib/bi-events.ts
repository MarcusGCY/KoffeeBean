import { z } from "zod";
import { biDbConfigured, getBiSql } from "./bi-db";
import { BiHashConfigError, hashShopperId } from "./bi-hash";

/**
 * BI event log writer (Neon). Analytics only. Events carry structured fields:
 * ids, counts, cents, enums. Never chat text, names, emails, or addresses, and
 * never the raw Auth0 `sub` (it is hashed with `hashShopperId` before insert).
 * Payload schemas are strict, so an unknown field is rejected instead of stored.
 */

export const BI_SOURCES = ["live", "demo"] as const;
export type BiSource = (typeof BI_SOURCES)[number];

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const couponCode = z.string().regex(/^[A-Z0-9_-]{1,32}$/);
const count = z.number().int().min(0).max(1_000_000);
const cents = z.number().int().min(0).max(100_000_000);
const lineItem = z.strictObject({ productId: id, qty: z.number().int().min(1).max(1000), unitPriceCents: cents });
const surface = z.enum(["chat", "product", "cart"]);

export const biPayloadSchemas = {
  /** One Barista chat turn. Lengths and tool ids only; the text itself is never logged. */
  "barista.turn": z.strictObject({
    outcome: z.enum(["replied", "rate_limited", "timeout", "error"]),
    userMessageChars: count,
    toolIds: z.array(id).max(20),
    latencyMs: count,
  }),
  "recommend.shown": z.strictObject({
    recommendationId: id,
    productIds: z.array(id).min(1).max(20),
    surface,
  }),
  "recommend.added": z.strictObject({
    recommendationId: id,
    productId: id,
    qty: z.number().int().min(1).max(1000),
  }),
  "recommend.undone": z.strictObject({
    recommendationId: id,
    productId: id,
  }),
  "order.placed": z.strictObject({
    orderId: id,
    subtotalCents: cents,
    discountCents: cents,
    taxCents: cents,
    totalCents: cents,
    coupon: couponCode.nullable(),
    items: z.array(lineItem).min(1).max(100),
  }),
  "order.cancelled": z.strictObject({
    orderId: id,
    totalCents: cents,
  }),
} as const;

export type BiEventType = keyof typeof biPayloadSchemas;
export type BiEventPayloads = { [K in BiEventType]: z.infer<(typeof biPayloadSchemas)[K]> };

export const BI_EVENT_TYPES = Object.keys(biPayloadSchemas) as BiEventType[];

export function isBiEventType(value: unknown): value is BiEventType {
  return typeof value === "string" && Object.hasOwn(biPayloadSchemas, value);
}

export type BiEventInput<T extends BiEventType = BiEventType> = {
  type: T;
  /** `live` for real shopper traffic. `demo` is written only by the BI demo seed. */
  source: BiSource;
  /** Raw Auth0 `sub`. Hashed here; never stored or logged. */
  shopperSub: string;
  /** Opaque, non-identifying session or chat id. */
  sessionId?: string | null;
  payload: BiEventPayloads[T];
};

export type BiRecordResult =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "invalid" | "error" };

export type BiEventRow = {
  eventType: BiEventType;
  source: BiSource;
  shopperHash: string;
  sessionId: string | null;
  payload: Record<string, unknown>;
};

const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

/** Validates an event and builds the row to insert. Throws on any invalid field. */
export function shapeBiEvent<T extends BiEventType>(input: BiEventInput<T>): BiEventRow {
  if (!isBiEventType(input.type)) throw new Error("bi_invalid_event_type");
  if (!BI_SOURCES.includes(input.source)) throw new Error("bi_invalid_source");
  const payload = biPayloadSchemas[input.type].parse(input.payload) as Record<string, unknown>;
  const sessionId = input.sessionId == null ? null : sessionIdSchema.parse(input.sessionId);
  return {
    eventType: input.type,
    source: input.source,
    shopperHash: hashShopperId(input.shopperSub),
    sessionId,
    payload,
  };
}

const WRITE_TIMEOUT_MS = 2000;

/**
 * Appends one event. Never throws and never blocks a shopper for long: a missing
 * database, a bad event, or a Neon outage returns `{ ok: false }` and logs a
 * short code (no payload, no connection string). Callers may ignore the result.
 */
export async function recordBiEvent<T extends BiEventType>(input: BiEventInput<T>): Promise<BiRecordResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!biDbConfigured()) return { ok: false, reason: "unconfigured" };
    let row: BiEventRow;
    try {
      row = shapeBiEvent(input);
    } catch (error) {
      if (error instanceof BiHashConfigError) return { ok: false, reason: "unconfigured" };
      console.error("[bi] invalid event", isBiEventType(input?.type) ? input.type : "unknown");
      return { ok: false, reason: "invalid" };
    }
    const sql = getBiSql();
    if (!sql) return { ok: false, reason: "unconfigured" };
    const insert = Promise.resolve(sql`
      INSERT INTO bi_events (event_type, source, shopper_hash, session_id, payload)
      VALUES (${row.eventType}, ${row.source}, ${row.shopperHash}, ${row.sessionId}, ${JSON.stringify(row.payload)}::jsonb)`);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), WRITE_TIMEOUT_MS);
    });
    insert.catch(() => undefined);
    await Promise.race([insert, timeout]);
    return { ok: true };
  } catch (error) {
    console.error("[bi] write failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
