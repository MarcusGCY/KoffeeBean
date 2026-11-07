import type { BiSql } from "./bi-db";
import { shapeBiEvent, type BiEventInput, type BiEventPayloads } from "./bi-events";
import { hashShopperId } from "./bi-hash";

/**
 * Demo seed for the BI event store. Writes synthetic analytics rows with
 * `source = 'demo'` into `bi_events` and the `bi_orders` mirror. Auth0
 * `app_metadata` stays the source of truth for carts and orders; nothing here
 * creates or reads a real order, and the checkout/cart paths never read these
 * rows. Shopper ids go through `hashShopperId` (synthetic subs, never a real
 * account) and events through `shapeBiEvent`, the validator behind
 * `recordBiEvent`, so payloads carry no chat text or PII.
 *
 * Story, "Cancellation spike": the Roast Day T-Shirt ($250) is ordered with
 * BEANS20 in the last ~30 hours and most of those orders are cancelled, after a
 * calm baseline of cheap beans and merch orders with 1 cancellation. Revenue per
 * order jumps while 8 of 12 spike orders are cancelled, so
 * `/api/bi/summary?source=demo` shows a cancellation rate and BEANS20 coupon
 * concentration far above normal.
 *
 * Re-runnable: every seeded row is keyed by a demo-only id prefix. A seed deletes
 * the previous story's rows (`source = 'demo'` AND the prefix) and inserts a
 * fresh set in one statement. `live` rows are never touched.
 */

export const DEMO_STORY_SESSION_PREFIX = "demo-story:";
export const DEMO_STORY_ORDER_PREFIX = "demo-story-";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHOPPER_COUNT = 6;
const BASELINE_DAYS = [6, 5, 4, 3, 2] as const;
const ORDERS_PER_BASELINE_DAY = 3;
const SPIKE_ORDERS = 12;

type Item = { productId: string; qty: number; unitPriceCents: number };

const BASELINE_ITEMS: Item[] = [
  { productId: "ethiopia-250", qty: 1, unitPriceCents: 1800 },
  { productId: "colombia-250", qty: 2, unitPriceCents: 1600 },
  { productId: "mug", qty: 1, unitPriceCents: 1400 },
  { productId: "tote", qty: 1, unitPriceCents: 1200 },
  { productId: "espresso-1kg", qty: 1, unitPriceCents: 4200 },
];
const SPIKE_ITEM: Item = { productId: "tee", qty: 1, unitPriceCents: 25_000 };

export type DemoStoryEvent = {
  createdAt: Date;
  eventType: string;
  shopperHash: string;
  sessionId: string;
  payload: Record<string, unknown>;
};

export type DemoStoryOrder = {
  orderId: string;
  shopperHash: string;
  createdAt: Date;
  cancelledAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  coupon: string | null;
  items: Item[];
  attributedSkuIds: string[];
};

export type DemoStory = { events: DemoStoryEvent[]; orders: DemoStoryOrder[] };

type Plan = { at: Date; item: Item; coupon: "SAVE10" | "BEANS20" | null; cancelled: boolean };

function plans(now: number): Plan[] {
  const out: Plan[] = [];
  for (const day of BASELINE_DAYS) {
    for (let n = 0; n < ORDERS_PER_BASELINE_DAY; n++) {
      const index = out.length;
      out.push({
        at: new Date(now - day * DAY - n * 3 * HOUR),
        item: BASELINE_ITEMS[index % BASELINE_ITEMS.length]!,
        coupon: n === 2 ? "SAVE10" : null,
        cancelled: day === 4 && n === 1,
      });
    }
  }
  for (let i = 0; i < SPIKE_ORDERS; i++) {
    out.push({
      at: new Date(now - (2 + i * 2.5) * HOUR),
      item: SPIKE_ITEM,
      coupon: "BEANS20",
      cancelled: i % 3 !== 2,
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function percentOff(coupon: Plan["coupon"]): number {
  return coupon === "BEANS20" ? 20 : coupon === "SAVE10" ? 10 : 0;
}

/**
 * Builds the whole story relative to `now`. Pure apart from reading
 * `BI_HASH_SECRET`; throws `BiHashConfigError` when it is unset.
 */
export function buildDemoStory(now: Date = new Date()): DemoStory {
  const hashes = Array.from({ length: SHOPPER_COUNT }, (_, i) => hashShopperId(`demo-seed|shopper-${i + 1}`));
  const events: DemoStoryEvent[] = [];
  const orders: DemoStoryOrder[] = [];

  const push = <T extends keyof BiEventPayloads>(
    type: T,
    at: Date,
    shopperIndex: number,
    sessionId: string,
    payload: BiEventPayloads[T],
  ) => {
    const input: BiEventInput<T> = {
      type,
      source: "demo",
      shopperSub: `demo-seed|shopper-${shopperIndex + 1}`,
      sessionId,
      payload,
    };
    const row = shapeBiEvent(input);
    events.push({ createdAt: at, eventType: row.eventType, shopperHash: row.shopperHash, sessionId, payload: row.payload });
  };

  plans(now.getTime()).forEach((plan, index) => {
    const n = index + 1;
    const shopper = index % SHOPPER_COUNT;
    const sessionId = `${DEMO_STORY_SESSION_PREFIX}${n}`;
    const orderId = `${DEMO_STORY_ORDER_PREFIX}${n}`;
    const recommendationId = `demo-rec-${n}`;
    const t = plan.at.getTime();
    const subtotalCents = plan.item.qty * plan.item.unitPriceCents;
    const discountCents = Math.round((subtotalCents * percentOff(plan.coupon)) / 100);
    const totalCents = subtotalCents - discountCents;
    const items = [plan.item];

    push("barista.turn", new Date(t - 12 * 60_000), shopper, sessionId, {
      outcome: "replied",
      userMessageChars: 40 + (n % 5) * 12,
      toolIds: ["recommend_products"],
      latencyMs: 1800 + (n % 4) * 350,
    });
    push("recommend.shown", new Date(t - 10 * 60_000), shopper, sessionId, {
      recommendationId,
      productIds: [plan.item.productId],
      surface: "chat",
    });
    push("recommend.added", new Date(t - 6 * 60_000), shopper, sessionId, {
      recommendationId,
      productId: plan.item.productId,
      qty: plan.item.qty,
    });
    push("order.placed", plan.at, shopper, sessionId, {
      orderId,
      subtotalCents,
      discountCents,
      taxCents: 0,
      totalCents,
      coupon: plan.coupon,
      items,
    });

    let cancelledAt: Date | null = null;
    if (plan.cancelled) {
      cancelledAt = new Date(t + 25 * 60_000);
      push("order.cancelled", cancelledAt, shopper, sessionId, { orderId, totalCents });
    }

    orders.push({
      orderId,
      shopperHash: hashes[shopper]!,
      createdAt: plan.at,
      cancelledAt,
      subtotalCents,
      discountCents,
      taxCents: 0,
      totalCents,
      coupon: plan.coupon,
      items,
      attributedSkuIds: [plan.item.productId],
    });
  });

  return { events, orders };
}

/**
 * Replaces the previous demo story with a fresh one in a single transaction.
 * `source = 'demo'` is a SQL literal in every clause, so no code path here can
 * delete or write a `live` row.
 */
export async function seedBiDemoStory(
  sql: BiSql,
  now: Date = new Date(),
): Promise<{ events: number; orders: number }> {
  const story = buildDemoStory(now);
  const eventRows = story.events.map((e) => ({
    created_at: e.createdAt.toISOString(),
    event_type: e.eventType,
    shopper_hash: e.shopperHash,
    session_id: e.sessionId,
    payload: e.payload,
  }));
  const orderRows = story.orders.map((o) => ({
    order_id: o.orderId,
    shopper_hash: o.shopperHash,
    created_at: o.createdAt.toISOString(),
    cancelled_at: o.cancelledAt ? o.cancelledAt.toISOString() : null,
    subtotal_cents: o.subtotalCents,
    discount_cents: o.discountCents,
    tax_cents: o.taxCents,
    total_cents: o.totalCents,
    coupon: o.coupon,
    items: o.items,
    attributed_sku_ids: o.attributedSkuIds,
  }));

  await sql.transaction((txn) => [
    txn.query(`DELETE FROM bi_events WHERE source = 'demo' AND session_id LIKE $1`, [`${DEMO_STORY_SESSION_PREFIX}%`]),
    txn.query(`DELETE FROM bi_orders WHERE source = 'demo' AND order_id LIKE $1`, [`${DEMO_STORY_ORDER_PREFIX}%`]),
    txn.query(
      `INSERT INTO bi_events (created_at, event_type, source, shopper_hash, session_id, payload)
       SELECT r.created_at, r.event_type, 'demo', r.shopper_hash, r.session_id, r.payload
       FROM jsonb_to_recordset($1::jsonb) AS r(
         created_at timestamptz, event_type text, shopper_hash text, session_id text, payload jsonb)
       ORDER BY r.created_at`,
      [JSON.stringify(eventRows)],
    ),
    txn.query(
      `INSERT INTO bi_orders (order_id, shopper_hash, created_at, cancelled_at, subtotal_cents, discount_cents,
                              tax_cents, total_cents, coupon, items, source, attributed_sku_ids)
       SELECT r.order_id, r.shopper_hash, r.created_at, r.cancelled_at, r.subtotal_cents, r.discount_cents,
              r.tax_cents, r.total_cents, r.coupon, r.items, 'demo',
              ARRAY(SELECT jsonb_array_elements_text(r.attributed_sku_ids))
       FROM jsonb_to_recordset($1::jsonb) AS r(
         order_id text, shopper_hash text, created_at timestamptz, cancelled_at timestamptz,
         subtotal_cents int, discount_cents int, tax_cents int, total_cents int, coupon text,
         items jsonb, attributed_sku_ids jsonb)`,
      [JSON.stringify(orderRows)],
    ),
  ]);

  return { events: story.events.length, orders: story.orders.length };
}
