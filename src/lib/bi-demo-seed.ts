import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import type { BiSql } from "./bi-db";
import { shapeBiEvent, type BiEventInput, type BiEventPayloads } from "./bi-events";
import { hashShopperId } from "./bi-hash";
import { biProfileSchema, buildBiProfileFacts, type BiProfileFacts } from "./bi-profiles";
import { computeProfile } from "./barista-profile";
import { getProduct, total } from "./cart";
import { ORDER_HISTORY_LIMIT } from "./coupon-offer";
import { demoShopperSub } from "./demo-shopper";

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

/**
 * Demo rows for `bi_customer_profiles` (migration 0003), one per synthetic story shopper. Regions are 2-digit
 * districts, the first three shoppers are marketing-consented and the last is flagged `is_test`, so
 * `/api/bi/profiles?source=demo` shows consented rows and an `excludedTest` count.
 */
export const DEMO_PROFILE_REGIONS = ["10", "18", "23", "27", "31", "68"] as const;

export type DemoProfileRow = { shopperHash: string; facts: BiProfileFacts };

export function buildDemoProfiles(now: Date = new Date()): DemoProfileRow[] {
  const story = buildDemoStory(now);
  return Array.from({ length: SHOPPER_COUNT }, (_, index) => {
    const shopperHash = hashShopperId(`demo-seed|shopper-${index + 1}`);
    const orders = story.orders.filter((order) => order.shopperHash === shopperHash);
    const mapped = orders.map((order) => ({
      createdAt: order.createdAt.toISOString(),
      cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
      totalCents: order.totalCents,
      items: order.items.map((item) => ({ productId: item.productId, qty: item.qty })),
    }));
    const rows = mapped.map((row) => ({ createdAt: row.createdAt, cancelledAt: row.cancelledAt, totalCents: row.totalCents }));
    const profile = computeProfile(mapped, { now });
    const consented = index < 3;
    const facts = buildBiProfileFacts({
      orders: rows,
      profile,
      region: DEMO_PROFILE_REGIONS[index] ?? null,
      marketing: consented ? { consent: true, at: new Date(now.getTime() - (index + 1) * 10 * DAY).toISOString() } : { consent: false, at: null },
      isTest: index === SHOPPER_COUNT - 1,
      now,
    });
    return { shopperHash, facts: biProfileSchema.parse(facts) };
  });
}

/**
 * Upserts the demo profile rows in one statement. Only rows that are already `source = 'demo'` can be
 * overwritten, so a live row is never touched. Run apart from the story transaction, so a database without
 * migration 0003 still seeds the story; the caller treats a failure here as "no profiles".
 */
export async function seedBiDemoProfiles(sql: BiSql, now: Date = new Date()): Promise<number> {
  const rows = buildDemoProfiles(now).map(({ shopperHash, facts }) => ({
    shopper_hash: shopperHash,
    segment: facts.segment,
    cadence_days: facts.cadenceDays,
    aov_cents: facts.aovCents,
    orders_90d: facts.orders90d,
    preferred_roast: facts.preferredRoast,
    region: facts.region,
    is_test: facts.isTest,
    marketing_consent: facts.marketingConsent,
    consent_at: facts.consentAt,
  }));
  await sql.query(
    `INSERT INTO bi_customer_profiles (shopper_hash, segment, cadence_days, aov_cents, orders_90d, preferred_roast,
                                       region, is_test, marketing_consent, consent_at, source, updated_at)
     SELECT r.shopper_hash, r.segment, r.cadence_days, r.aov_cents, r.orders_90d, r.preferred_roast,
            r.region, r.is_test, r.marketing_consent, r.consent_at, 'demo', $2::timestamptz
     FROM jsonb_to_recordset($1::jsonb) AS r(
       shopper_hash text, segment text, cadence_days int, aov_cents int, orders_90d int, preferred_roast text,
       region text, is_test boolean, marketing_consent boolean, consent_at timestamptz)
     ON CONFLICT (shopper_hash) DO UPDATE SET
       segment = EXCLUDED.segment, cadence_days = EXCLUDED.cadence_days, aov_cents = EXCLUDED.aov_cents,
       orders_90d = EXCLUDED.orders_90d, preferred_roast = EXCLUDED.preferred_roast, region = EXCLUDED.region,
       is_test = EXCLUDED.is_test, marketing_consent = EXCLUDED.marketing_consent, consent_at = EXCLUDED.consent_at,
       updated_at = EXCLUDED.updated_at
     WHERE bi_customer_profiles.source = 'demo'`,
    [JSON.stringify(rows), now.toISOString()],
  );
  return rows.length;
}

/**
 * Demo shopper orders in Auth0 `app_metadata.orders`. Unlike the BI story above,
 * these are the shopper's own order rows (what `listOrders` reads), but only for
 * the one account configured in `DEMO_SHOPPER_SUB`. Every seeded row has
 * `demo: true` and an id that starts with `DEMO_SHOPPER_ORDER_PREFIX`. A re-seed
 * replaces only rows with `demo === true`; other orders are left as stored.
 */
export const DEMO_SHOPPER_ORDER_PREFIX = "BB-DEMO-";

export class DemoShopperError extends Error {
  constructor(readonly reason: "not_configured" | "not_demo_shopper") {
    super(reason);
    this.name = "DemoShopperError";
  }
}

export type DemoShopperOrder = {
  id: string;
  createdAt: string;
  cancelledAt: null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  coupon: null;
  items: { productId: string; name: string; unitPriceCents: number; qty: number }[];
  demo: true;
};

const DEMO_SHOPPER_PLAN = [
  { id: "ETHIOPIA", daysAgo: 12, lines: [{ productId: "ethiopia-250", qty: 1 }] },
  {
    id: "OLDER",
    daysAgo: 45,
    lines: [
      { productId: "colombia-250", qty: 2 },
      { productId: "mug", qty: 1 },
    ],
  },
];

/** Pure. Newest first, priced from the catalogue with the shop's own `total`. */
export function buildDemoShopperOrders(now: Date = new Date()): DemoShopperOrder[] {
  return DEMO_SHOPPER_PLAN.map((plan) => {
    const priced = total(plan.lines.map((line) => ({ productId: line.productId, quantity: line.qty })));
    return {
      id: `${DEMO_SHOPPER_ORDER_PREFIX}${plan.id}`,
      createdAt: new Date(now.getTime() - plan.daysAgo * DAY).toISOString(),
      cancelledAt: null,
      subtotalCents: priced.subtotal,
      discountCents: priced.discount,
      taxCents: priced.tax,
      totalCents: priced.total,
      coupon: null,
      items: plan.lines.map((line) => {
        const product = getProduct(line.productId);
        if (!product) throw new Error(`Unknown demo product ${line.productId}`);
        return { productId: product.id, name: product.name, unitPriceCents: product.price, qty: line.qty };
      }),
      demo: true as const,
    };
  });
}

function isDemoRow(row: unknown): boolean {
  return Boolean(row) && typeof row === "object" && (row as Record<string, unknown>).demo === true;
}

function createdAtMs(row: unknown): number {
  const value = row && typeof row === "object" ? (row as Record<string, unknown>).createdAt : undefined;
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Writes the demo orders to the configured demo shopper and marks the account
 * `is_test`. Throws `DemoShopperError` when `DEMO_SHOPPER_SUB` is unset or
 * `sub` is any other account, before any Auth0 call. Callers must already have
 * checked admin or service auth.
 */
export async function seedDemoShopperOrders(
  sub: string,
  now: Date = new Date(),
): Promise<{ seeded: number; replaced: number }> {
  const configured = demoShopperSub();
  if (!configured) throw new DemoShopperError("not_configured");
  if (sub !== configured) throw new DemoShopperError("not_demo_shopper");

  const meta = await getAppMetadata(configured);
  const stored = Array.isArray(meta.orders) ? meta.orders : [];
  const kept = stored.filter((row) => !isDemoRow(row));
  const merged = [...buildDemoShopperOrders(now), ...kept]
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))
    .slice(0, ORDER_HISTORY_LIMIT);

  await patchAppMetadata(configured, { orders: merged, is_test: true });
  return {
    seeded: merged.filter(isDemoRow).length,
    replaced: stored.length - kept.length,
  };
}
