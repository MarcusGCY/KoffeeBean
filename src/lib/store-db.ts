import { Pool, neonConfig } from "@neondatabase/serverless";
import type { CartItem } from "./types";
import { addItem, getProduct, removeItem, total } from "./cart";
import { checkout } from "./checkout";
import { findCoupon } from "./coupons";
import { canCancel, orderStatus } from "./order-status";
import type { CartSnapshot, OrderDetail, OrderSummary } from "./store-types";

if (neonConfig.webSocketConstructor === undefined && typeof WebSocket !== "undefined") {
  neonConfig.webSocketConstructor = WebSocket as unknown as NonNullable<typeof neonConfig.webSocketConstructor>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super("store_unavailable");
    this.name = "StoreUnavailableError";
  }
}

type SqlValue = string | number | Date | null;
type Sql = (text: string, params?: SqlValue[]) => Promise<Record<string, unknown>[]>;

let pool: Pool | undefined;

function getPool(): Pool {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new StoreUnavailableError();
  if (!pool) pool = new Pool({ connectionString: url, max: 1 });
  return pool;
}

async function query(text: string, params: SqlValue[] = []): Promise<Record<string, unknown>[]> {
  const result = await getPool().query(text, params);
  return result.rows as Record<string, unknown>[];
}

async function withTx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const q: Sql = async (text, params = []) => {
      const result = await client.query(text, params);
      return result.rows as Record<string, unknown>[];
    };
    const value = await fn(q);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error is the one to surface.
    }
    throw err;
  } finally {
    client.release();
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function cents(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function snapshot(items: CartItem[], coupon: string | null): CartSnapshot {
  const priced = total(items, coupon ?? "");
  return {
    items: items.map((item) => ({ productId: item.productId, qty: item.quantity })),
    coupon,
    subtotalCents: priced.subtotal,
    discountCents: priced.discount,
    taxCents: priced.tax,
    totalCents: priced.total,
  };
}

function rowsToItems(rows: Record<string, unknown>[]): CartItem[] {
  return rows.map((row) => ({
    productId: String(row.product_id),
    quantity: cents(row.qty),
  }));
}

async function readCart(q: Sql, userId: string): Promise<{ items: CartItem[]; coupon: string | null }> {
  const carts = await q(`SELECT coupon FROM carts WHERE user_id = $1`, [userId]);
  const itemRows = await q(
    `SELECT product_id, qty FROM cart_items WHERE user_id = $1 ORDER BY product_id`,
    [userId],
  );
  return { items: rowsToItems(itemRows), coupon: text(carts[0]?.coupon) };
}

async function lockCart(q: Sql, userId: string, now: Date): Promise<{ items: CartItem[]; coupon: string | null }> {
  await q(
    `INSERT INTO carts (user_id, updated_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, now],
  );
  await q(`SELECT coupon FROM carts WHERE user_id = $1 FOR UPDATE`, [userId]);
  return readCart(q, userId);
}

async function replaceItems(q: Sql, userId: string, items: CartItem[], now: Date): Promise<void> {
  await q(`DELETE FROM cart_items WHERE user_id = $1`, [userId]);
  for (const item of items) {
    await q(`INSERT INTO cart_items (user_id, product_id, qty) VALUES ($1, $2, $3)`, [
      userId,
      item.productId,
      item.quantity,
    ]);
  }
  await q(`UPDATE carts SET updated_at = $2 WHERE user_id = $1`, [userId, now]);
}

function summarize(row: Record<string, unknown>, now: Date): OrderSummary {
  const createdAt = asDate(row.created_at);
  const cancelledAt = row.cancelled_at == null ? null : asDate(row.cancelled_at);
  const status = orderStatus(createdAt, cancelledAt, now);
  return {
    id: String(row.id),
    createdAt: createdAt.toISOString(),
    status,
    cancellable: canCancel(status),
    totalCents: cents(row.total_cents),
    subtotalCents: cents(row.subtotal_cents),
    discountCents: cents(row.discount_cents),
    taxCents: cents(row.tax_cents),
    coupon: text(row.coupon),
  };
}

const ORDER_COLUMNS = `id, user_id, created_at, cancelled_at, subtotal_cents, discount_cents, tax_cents, total_cents, coupon`;

export async function getCart(userId: string): Promise<CartSnapshot> {
  const cart = await readCart(query, userId);
  return snapshot(cart.items, cart.coupon);
}

/** Uses addItem, including the planted tote id rewrite, so that bug still no-ops. */
export async function addToCart(
  userId: string,
  productId: string,
  qty = 1,
  now = new Date(),
): Promise<CartSnapshot | { error: "qty_limit" }> {
  return withTx(async (q) => {
    const current = await lockCart(q, userId, now);
    let items = current.items;
    for (let i = 0; i < qty; i++) items = addItem(items, productId);
    if (items.some((item) => item.quantity > 99)) return { error: "qty_limit" };
    await replaceItems(q, userId, items, now);
    return snapshot(items, current.coupon);
  });
}

export async function removeFromCart(userId: string, productId: string, qty = 1, now = new Date()): Promise<CartSnapshot> {
  return withTx(async (q) => {
    const current = await lockCart(q, userId, now);
    let items = current.items;
    for (let i = 0; i < qty; i++) items = removeItem(items, productId);
    await replaceItems(q, userId, items, now);
    return snapshot(items, current.coupon);
  });
}

export async function applyCoupon(
  userId: string,
  code: string,
  now = new Date(),
): Promise<CartSnapshot | { error: "invalid_coupon" }> {
  const coupon = findCoupon(code);
  if (!coupon) return { error: "invalid_coupon" };
  return withTx(async (q) => {
    await q(
      `INSERT INTO carts (user_id, coupon, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET coupon = EXCLUDED.coupon, updated_at = EXCLUDED.updated_at`,
      [userId, coupon.code, now],
    );
    const cart = await readCart(q, userId);
    return snapshot(cart.items, coupon.code);
  });
}

export async function clearCoupon(userId: string, now = new Date()): Promise<CartSnapshot> {
  await query(`UPDATE carts SET coupon = NULL, updated_at = $2 WHERE user_id = $1`, [userId, now]);
  return getCart(userId);
}

export async function placeOrder(
  userId: string,
  now = new Date(),
): Promise<OrderSummary | { error: "empty_cart" }> {
  return withTx(async (q) => {
    const current = await lockCart(q, userId, now);
    const known = current.items.filter((item) => getProduct(item.productId));
    let draft = checkout(known, current.coupon ?? "");
    if (!draft) return { error: "empty_cart" };

    for (let attempt = 0; attempt < 3; attempt++) {
      const clash = await q(`SELECT 1 FROM orders WHERE id = $1`, [draft.id]);
      if (clash.length === 0) break;
      const again = checkout(known, current.coupon ?? "");
      if (!again) return { error: "empty_cart" };
      draft = again;
    }

    const savedCoupon = current.coupon ? findCoupon(current.coupon)?.code ?? null : null;
    await q(
      `INSERT INTO orders (id, user_id, subtotal_cents, discount_cents, tax_cents, total_cents, coupon, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [draft.id, userId, draft.subtotal, draft.discount, draft.tax, draft.total, savedCoupon, now],
    );
    for (const item of draft.items) {
      const product = getProduct(item.productId);
      if (!product) continue;
      await q(
        `INSERT INTO order_items (order_id, product_id, name, unit_price_cents, qty) VALUES ($1, $2, $3, $4, $5)`,
        [draft.id, item.productId, product.name, product.price, item.quantity],
      );
    }
    await q(`DELETE FROM cart_items WHERE user_id = $1`, [userId]);
    await q(`UPDATE carts SET coupon = NULL, updated_at = $2 WHERE user_id = $1`, [userId, now]);

    const rows = await q(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 AND user_id = $2`, [draft.id, userId]);
    const row = rows[0];
    if (!row) throw new Error("order insert failed");
    return summarize(row, now);
  });
}

export async function listOrders(userId: string, now = new Date()): Promise<OrderSummary[]> {
  const rows = await query(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => summarize(row, now));
}

export async function getOrder(userId: string, id: string, now = new Date()): Promise<OrderDetail | null> {
  const rows = await query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!rows[0]) return null;
  const items = await query(
    `SELECT product_id, name, unit_price_cents, qty FROM order_items WHERE order_id = $1 ORDER BY product_id`,
    [id],
  );
  return {
    ...summarize(rows[0], now),
    items: items.map((item) => ({
      productId: String(item.product_id),
      name: String(item.name),
      unitPriceCents: cents(item.unit_price_cents),
      qty: cents(item.qty),
    })),
  };
}

export async function cancelOrder(
  userId: string,
  id: string,
  now = new Date(),
): Promise<OrderSummary | { error: "not_found" } | { error: "not_cancellable" }> {
  return withTx(async (q) => {
    const rows = await q(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
      id,
      userId,
    ]);
    if (!rows[0]) return { error: "not_found" };
    const createdAt = asDate(rows[0].created_at);
    const cancelledAt = rows[0].cancelled_at == null ? null : asDate(rows[0].cancelled_at);
    if (!canCancel(orderStatus(createdAt, cancelledAt, now))) return { error: "not_cancellable" };
    await q(`UPDATE orders SET cancelled_at = $3 WHERE id = $1 AND user_id = $2`, [id, userId, now]);
    const updated = await q(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 AND user_id = $2`, [id, userId]);
    const row = updated[0];
    if (!row) throw new Error("order update failed");
    return summarize(row, now);
  });
}
