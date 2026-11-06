import { randomBytes } from "node:crypto";
import { after } from "next/server";
import { biPayloadSchemas, recordBiEvent, type BiEventPayloads, type BiSource } from "./bi-events";
import { biDbConfigured, getBiSql } from "./bi-db";
import { hashShopperId } from "./bi-hash";
import { readAdmin } from "./demo-session";
import { redisPipeline } from "./upstash";

/**
 * Call sites for the BI event log. Every helper here swallows its own failures:
 * analytics must never break chat, the cart, or checkout. No message text, names,
 * emails, or raw Auth0 `sub` leaves this module except into `recordBiEvent`, which
 * hashes the sub.
 */

/** How long an "added from a recommendation" mark can credit a later order. */
export const ATTRIBUTION_TTL_SEC = 30 * 60;

const SQL_TIMEOUT_MS = 2000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_SESSION = /^[A-Za-z0-9_.:-]{1,64}$/;

export type BiContext = {
  /** Raw Auth0 `sub` of the signed-in shopper. */
  sub: string;
  /** Pass when already known; otherwise it is read from the session (admin => demo). */
  source?: BiSource;
  sessionId?: string | null;
};

/**
 * `demo` when the signed-in user has the Auth0 `admin` role (the same check that
 * gates `/admin/demo` and Demo Reset), `live` for every other shopper. Any failure
 * to read the session falls back to `live`; the caller already authenticated.
 */
export async function biSource(): Promise<BiSource> {
  try {
    return (await readAdmin()) ? "demo" : "live";
  } catch {
    return "live";
  }
}

/** Opaque chat session id from the client, or null when it is not BI-safe. */
export function biSessionId(raw: unknown): string | null {
  return typeof raw === "string" && SAFE_SESSION.test(raw) ? raw : null;
}

export function biId(raw: unknown): string | null {
  return typeof raw === "string" && SAFE_ID.test(raw) ? raw : null;
}

/** Runs `task` after the response when inside a request, otherwise right away. Never throws. */
export function emitBi(task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch {
      console.error("[bi] emit failed");
    }
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

async function resolve(ctx: BiContext): Promise<{ source: BiSource; sessionId: string | null }> {
  return { source: ctx.source ?? (await biSource()), sessionId: biSessionId(ctx.sessionId) };
}

export async function trackTurn(ctx: BiContext, payload: BiEventPayloads["barista.turn"]): Promise<void> {
  const { source, sessionId } = await resolve(ctx);
  await recordBiEvent({ type: "barista.turn", source, shopperSub: ctx.sub, sessionId, payload });
}

export async function trackShown(ctx: BiContext, payload: Omit<BiEventPayloads["recommend.shown"], "surface">): Promise<void> {
  const { source, sessionId } = await resolve(ctx);
  await recordBiEvent({
    type: "recommend.shown",
    source,
    shopperSub: ctx.sub,
    sessionId,
    payload: { ...payload, surface: "chat" },
  });
}

export async function trackAdded(ctx: BiContext, payload: BiEventPayloads["recommend.added"]): Promise<void> {
  await rememberRecommendedAdd(ctx.sub, payload.productId);
  const { source, sessionId } = await resolve(ctx);
  await recordBiEvent({ type: "recommend.added", source, shopperSub: ctx.sub, sessionId, payload });
}

export async function trackUndone(ctx: BiContext, payload: BiEventPayloads["recommend.undone"]): Promise<void> {
  await forgetRecommendedAdd(ctx.sub, payload.productId);
  const { source, sessionId } = await resolve(ctx);
  await recordBiEvent({ type: "recommend.undone", source, shopperSub: ctx.sub, sessionId, payload });
}

export type TurnOutcome = BiEventPayloads["barista.turn"]["outcome"];

/**
 * Collects one Barista turn: tool ids, the product cards shown (one recommendation id
 * per turn), and latency. `finish` emits `recommend.shown` (if cards were shown) and
 * `barista.turn`, once. Only lengths and ids are kept, never message text.
 */
export function startTurn(
  ctx: BiContext,
  userMessageChars: number,
  knownTools: readonly string[],
  now: () => number = Date.now,
) {
  const started = now();
  const toolIds: string[] = [];
  const shown: string[] = [];
  const known = new Set<string>(knownTools);
  let recommendationId: string | null = null;
  let finished = false;
  return {
    tool(name: string) {
      if (known.has(name) && !toolIds.includes(name) && toolIds.length < 20) toolIds.push(name);
    },
    /** Records cards shown and returns this turn's recommendation id. */
    shownProducts(ids: string[]): string {
      recommendationId ??= `rec_${randomBytes(6).toString("hex")}`;
      for (const id of ids) if (SAFE_ID.test(id) && !shown.includes(id) && shown.length < 20) shown.push(id);
      return recommendationId;
    },
    finish(outcome: TurnOutcome) {
      if (finished) return;
      finished = true;
      const latencyMs = Math.max(0, Math.min(1_000_000, now() - started));
      const payload = {
        outcome,
        userMessageChars: Math.max(0, Math.min(1_000_000, Math.trunc(userMessageChars))),
        toolIds: [...toolIds],
        latencyMs,
      };
      const recommendation = recommendationId;
      const productIds = [...shown];
      emitBi(async () => {
        if (recommendation && productIds.length > 0) {
          await trackShown(ctx, { recommendationId: recommendation, productIds });
        }
        await trackTurn(ctx, payload);
      });
    },
  };
}

export type PlacedOrder = {
  id: string;
  createdAt: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  coupon: string | null;
  items: { productId: string; qty: number; unitPriceCents: number }[];
};

/** `order.placed` event plus a `bi_orders` upsert credited with recently recommended SKUs. */
export async function trackOrderPlaced(ctx: BiContext, order: PlacedOrder): Promise<void> {
  const { source } = await resolve(ctx);
  const payload: BiEventPayloads["order.placed"] = {
    orderId: order.id,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    coupon: order.coupon,
    items: order.items.map((item) => ({
      productId: item.productId,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
    })),
  };
  const attributed = await takeAttributedSkus(
    ctx.sub,
    order.items.map((item) => item.productId),
  );
  await recordBiEvent({ type: "order.placed", source, shopperSub: ctx.sub, sessionId: ctx.sessionId, payload });
  await upsertBiOrder(ctx.sub, source, order.createdAt, payload, attributed);
}

/** `order.cancelled` event plus `bi_orders.cancelled_at`. */
export async function trackOrderCancelled(
  ctx: BiContext,
  order: { id: string; totalCents: number; cancelledAt: string },
): Promise<void> {
  const { source } = await resolve(ctx);
  await recordBiEvent({
    type: "order.cancelled",
    source,
    shopperSub: ctx.sub,
    sessionId: ctx.sessionId,
    payload: { orderId: order.id, totalCents: order.totalCents },
  });
  await markBiOrderCancelled(ctx.sub, order.id, order.cancelledAt);
}

function attributionKey(sub: string, productId: string): string {
  return `kb:bi:rec:${sub}:${productId}`;
}

/** Marks a SKU as recently added from a recommendation. Best effort. */
export async function rememberRecommendedAdd(sub: string, productId: string): Promise<void> {
  try {
    await redisPipeline([["SET", attributionKey(sub, productId), "1", "EX", ATTRIBUTION_TTL_SEC]]);
  } catch {
    console.error("[bi] attribution write failed");
  }
}

export async function forgetRecommendedAdd(sub: string, productId: string): Promise<void> {
  try {
    await redisPipeline([["DEL", attributionKey(sub, productId)]]);
  } catch {
    console.error("[bi] attribution clear failed");
  }
}

/**
 * Of `productIds`, the SKUs still marked inside the TTL window. Marks are consumed so
 * a later order does not credit the same recommendation twice. Empty on any failure.
 */
export async function takeAttributedSkus(sub: string, productIds: string[]): Promise<string[]> {
  const unique = [...new Set(productIds.filter((id) => SAFE_ID.test(id)))];
  if (unique.length === 0) return [];
  try {
    const keys = unique.map((id) => attributionKey(sub, id));
    const [marks] = await redisPipeline([["MGET", ...keys]]);
    if (!Array.isArray(marks)) return [];
    const hits = unique.filter((_, index) => marks[index] != null);
    if (hits.length > 0) await redisPipeline([["DEL", ...hits.map((id) => attributionKey(sub, id))]]);
    return hits;
  } catch {
    console.error("[bi] attribution read failed");
    return [];
  }
}

async function biSql(run: (sql: NonNullable<ReturnType<typeof getBiSql>>) => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!biDbConfigured()) return;
    const sql = getBiSql();
    if (!sql) return;
    const query = Promise.resolve(run(sql));
    query.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), SQL_TIMEOUT_MS);
    });
    await Promise.race([query, timeout]);
  } catch (error) {
    console.error("[bi] order write failed", error instanceof Error ? error.name : "unknown");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function upsertBiOrder(
  sub: string,
  source: BiSource,
  createdAt: string,
  order: BiEventPayloads["order.placed"],
  attributed: string[],
): Promise<void> {
  await biSql(async (sql) => {
    const checked = biPayloadSchemas["order.placed"].parse(order);
    const hash = hashShopperId(sub);
    await sql`
      INSERT INTO bi_orders (order_id, shopper_hash, created_at, subtotal_cents, discount_cents, tax_cents,
                             total_cents, coupon, items, source, attributed_sku_ids)
      VALUES (${checked.orderId}, ${hash}, ${createdAt}, ${checked.subtotalCents}, ${checked.discountCents},
              ${checked.taxCents}, ${checked.totalCents}, ${checked.coupon}, ${JSON.stringify(checked.items)}::jsonb,
              ${source}, ${attributed})
      ON CONFLICT (order_id) DO UPDATE SET
        subtotal_cents = EXCLUDED.subtotal_cents,
        discount_cents = EXCLUDED.discount_cents,
        tax_cents = EXCLUDED.tax_cents,
        total_cents = EXCLUDED.total_cents,
        coupon = EXCLUDED.coupon,
        items = EXCLUDED.items,
        attributed_sku_ids = EXCLUDED.attributed_sku_ids`;
  });
}

async function markBiOrderCancelled(sub: string, orderId: string, cancelledAt: string): Promise<void> {
  await biSql(async (sql) => {
    const id = biPayloadSchemas["order.cancelled"].shape.orderId.parse(orderId);
    const hash = hashShopperId(sub);
    await sql`
      UPDATE bi_orders SET cancelled_at = ${cancelledAt}
      WHERE order_id = ${id} AND shopper_hash = ${hash} AND cancelled_at IS NULL`;
  });
}
