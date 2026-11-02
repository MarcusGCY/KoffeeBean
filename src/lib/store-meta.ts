import type { CartItem } from "./types";
import { addItem, getProduct, removeItem, total } from "./cart";
import { checkout, type Order } from "./checkout";
import { findCoupon } from "./coupons";
import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { normalizeLimits, rateLimited, takeSlot, type RateLimited } from "./limits";
import { canCancel, orderStatus } from "./order-status";
import type { CartSnapshot, OrderDetail, OrderSummary } from "./store-types";

/**
 * Per-shopper cart, orders, and audit stored in Auth0 `app_metadata`.
 * Auth0 merges only top-level keys, so each patch sends the full value of
 * every key it changes and omits the rest. Two writers that patch the same
 * key are last-write-wins (a lost cart line or a lost quota stamp is acceptable
 * for this demo).
 *
 * Keys: `cart`, `orders` (newest 20), `chat_limits`, `audit` (newest 50).
 */

const ORDER_CAP = 20;
const AUDIT_CAP = 50;

type StoredItem = { productId: string; name: string; unitPriceCents: number; qty: number };

type StoredOrder = {
  id: string;
  createdAt: string;
  cancelledAt: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  coupon: string | null;
  items: StoredItem[];
};

export type AuditEntry = { ts: string; tool: string; summary: string; outcome: string };

type CartState = { items: CartItem[]; coupon: string | null };

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validQty(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= 99;
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

function readCart(meta: Record<string, unknown>): CartState {
  const cart = meta.cart;
  if (!cart || typeof cart !== "object" || Array.isArray(cart)) return { items: [], coupon: null };
  const record = cart as { items?: unknown; coupon?: unknown };
  const items: CartItem[] = [];
  if (Array.isArray(record.items)) {
    for (const row of record.items) {
      if (!row || typeof row !== "object") continue;
      const line = row as { productId?: unknown; qty?: unknown };
      if (typeof line.productId !== "string" || !line.productId) continue;
      if (typeof line.qty !== "number" || !validQty(line.qty)) continue;
      items.push({ productId: line.productId, quantity: line.qty });
    }
  }
  const coupon = typeof record.coupon === "string" && record.coupon ? record.coupon : null;
  return { items, coupon };
}

function storedCart(items: CartItem[], coupon: string | null) {
  return {
    items: items.map((item) => ({ productId: item.productId, qty: item.quantity })),
    coupon,
  };
}

function sameCart(left: CartItem[], right: CartItem[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.productId === right[index]?.productId && item.quantity === right[index]?.quantity);
}

function readOrders(meta: Record<string, unknown>): StoredOrder[] {
  if (!Array.isArray(meta.orders)) return [];
  const orders: StoredOrder[] = [];
  for (const row of meta.orders) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.createdAt !== "string") continue;
    if (Number.isNaN(new Date(record.createdAt).getTime())) continue;
    const subtotalCents = finite(record.subtotalCents);
    const discountCents = finite(record.discountCents);
    const taxCents = finite(record.taxCents);
    const totalCents = finite(record.totalCents);
    if (subtotalCents == null || discountCents == null || taxCents == null || totalCents == null) continue;
    const items: StoredItem[] = [];
    if (Array.isArray(record.items)) {
      for (const item of record.items) {
        if (!item || typeof item !== "object") continue;
        const line = item as Record<string, unknown>;
        const unitPriceCents = finite(line.unitPriceCents);
        const qty = finite(line.qty);
        if (typeof line.productId !== "string" || typeof line.name !== "string") continue;
        if (unitPriceCents == null || qty == null || !validQty(qty)) continue;
        items.push({ productId: line.productId, name: line.name, unitPriceCents, qty });
      }
    }
    orders.push({
      id: record.id,
      createdAt: record.createdAt,
      cancelledAt: typeof record.cancelledAt === "string" ? record.cancelledAt : null,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents,
      coupon: typeof record.coupon === "string" && record.coupon ? record.coupon : null,
      items,
    });
  }
  return orders.slice(0, ORDER_CAP);
}

function summarize(order: StoredOrder, now: Date): OrderSummary {
  const createdAt = new Date(order.createdAt);
  const cancelledAt = order.cancelledAt ? new Date(order.cancelledAt) : null;
  const status = orderStatus(createdAt, cancelledAt, now);
  return {
    id: order.id,
    createdAt: createdAt.toISOString(),
    status,
    cancellable: canCancel(status),
    totalCents: order.totalCents,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    taxCents: order.taxCents,
    coupon: order.coupon,
  };
}

function detail(order: StoredOrder, now: Date): OrderDetail {
  return {
    ...summarize(order, now),
    items: order.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      unitPriceCents: item.unitPriceCents,
      qty: item.qty,
    })),
  };
}

async function consume(meta: Record<string, unknown>, kind: "cartWrites" | "orderWrites", now: Date) {
  return takeSlot(normalizeLimits(meta.chat_limits), kind, now.getTime());
}

export async function getCart(userId: string): Promise<CartSnapshot> {
  const cart = readCart(await getAppMetadata(userId));
  return snapshot(cart.items, cart.coupon);
}

/** Uses addItem, including the planted tote id rewrite, so that bug still no-ops. */
export async function addToCart(
  userId: string,
  productId: string,
  qty = 1,
  now = new Date(),
): Promise<CartSnapshot | { error: "qty_limit" } | RateLimited> {
  if (!validQty(qty)) return { error: "qty_limit" };
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  let items = current.items;
  for (let i = 0; i < qty; i++) items = addItem(items, productId);
  if (items.some((item) => item.quantity > 99)) return { error: "qty_limit" };
  if (sameCart(items, current.items)) return snapshot(items, current.coupon);
  const decision = await consume(meta, "cartWrites", now);
  if (!decision.ok) return rateLimited("cartWrites", decision.retryAfterSec);
  await patchAppMetadata(userId, {
    cart: storedCart(items, current.coupon),
    chat_limits: decision.limits,
  });
  return snapshot(items, current.coupon);
}

/** Sets an absolute quantity using addItem and removeItem, so the planted tote rewrite still no-ops. */
export async function setCartQty(
  userId: string,
  productId: string,
  qty: number,
  now = new Date(),
): Promise<CartSnapshot | { error: "qty_limit" } | RateLimited> {
  if (!validQty(qty)) return { error: "qty_limit" };
  const current = readCart(await getAppMetadata(userId));
  const have = current.items.find((item) => item.productId === productId)?.quantity ?? 0;
  if (qty === have) return snapshot(current.items, current.coupon);
  if (qty > have) return addToCart(userId, productId, qty - have, now);
  return removeFromCart(userId, productId, have - qty, now);
}

export async function removeFromCart(
  userId: string,
  productId: string,
  qty = 1,
  now = new Date(),
): Promise<CartSnapshot | { error: "qty_limit" } | RateLimited> {
  if (!validQty(qty)) return { error: "qty_limit" };
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  let items = current.items;
  for (let i = 0; i < qty; i++) items = removeItem(items, productId);
  if (sameCart(items, current.items)) return snapshot(items, current.coupon);
  const decision = await consume(meta, "cartWrites", now);
  if (!decision.ok) return rateLimited("cartWrites", decision.retryAfterSec);
  await patchAppMetadata(userId, {
    cart: storedCart(items, current.coupon),
    chat_limits: decision.limits,
  });
  return snapshot(items, current.coupon);
}

export async function applyCoupon(
  userId: string,
  code: string,
  now = new Date(),
): Promise<CartSnapshot | { error: "invalid_coupon" } | RateLimited> {
  const coupon = findCoupon(code);
  if (!coupon) return { error: "invalid_coupon" };
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  const decision = await consume(meta, "cartWrites", now);
  if (!decision.ok) return rateLimited("cartWrites", decision.retryAfterSec);
  await patchAppMetadata(userId, {
    cart: storedCart(current.items, coupon.code),
    chat_limits: decision.limits,
  });
  return snapshot(current.items, coupon.code);
}

export async function clearCoupon(userId: string, now = new Date()): Promise<CartSnapshot | RateLimited> {
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  if (!current.coupon) return snapshot(current.items, null);
  const decision = await consume(meta, "cartWrites", now);
  if (!decision.ok) return rateLimited("cartWrites", decision.retryAfterSec);
  await patchAppMetadata(userId, {
    cart: storedCart(current.items, null),
    chat_limits: decision.limits,
  });
  return snapshot(current.items, null);
}

export async function placeOrder(
  userId: string,
  now = new Date(),
): Promise<OrderSummary | { error: "empty_cart" } | RateLimited> {
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  const known = current.items.filter((item) => getProduct(item.productId));
  const first = checkout(known, current.coupon ?? "");
  if (!first) return { error: "empty_cart" };
  let draft: Order = first;

  const existing = readOrders(meta);
  for (let attempt = 0; attempt < 3 && existing.some((order) => order.id === draft.id); attempt++) {
    const again = checkout(known, current.coupon ?? "");
    if (!again) return { error: "empty_cart" };
    draft = again;
  }
  if (existing.some((order) => order.id === draft.id)) throw new Error("order id clash");

  const decision = await consume(meta, "orderWrites", now);
  if (!decision.ok) return rateLimited("orderWrites", decision.retryAfterSec);

  const savedCoupon = current.coupon ? (findCoupon(current.coupon)?.code ?? null) : null;
  const stored: StoredOrder = {
    id: draft.id,
    createdAt: now.toISOString(),
    cancelledAt: null,
    subtotalCents: draft.subtotal,
    discountCents: draft.discount,
    taxCents: draft.tax,
    totalCents: draft.total,
    coupon: savedCoupon,
    items: draft.items.flatMap((item) => {
      const product = getProduct(item.productId);
      if (!product) return [];
      return [{ productId: item.productId, name: product.name, unitPriceCents: product.price, qty: item.quantity }];
    }),
  };
  await patchAppMetadata(userId, {
    orders: [stored, ...existing].slice(0, ORDER_CAP),
    cart: storedCart([], null),
    chat_limits: decision.limits,
  });
  return summarize(stored, now);
}

export async function listOrders(userId: string, now = new Date()): Promise<OrderSummary[]> {
  return readOrders(await getAppMetadata(userId)).map((order) => summarize(order, now));
}

export async function getOrder(userId: string, id: string, now = new Date()): Promise<OrderDetail | null> {
  const order = readOrders(await getAppMetadata(userId)).find((item) => item.id === id);
  return order ? detail(order, now) : null;
}

export async function cancelOrder(
  userId: string,
  id: string,
  now = new Date(),
): Promise<OrderSummary | { error: "not_found" } | { error: "not_cancellable" } | RateLimited> {
  const meta = await getAppMetadata(userId);
  const orders = readOrders(meta);
  const index = orders.findIndex((order) => order.id === id);
  if (index < 0) return { error: "not_found" };
  const current = orders[index];
  if (!current) return { error: "not_found" };
  const createdAt = new Date(current.createdAt);
  const cancelledAt = current.cancelledAt ? new Date(current.cancelledAt) : null;
  if (!canCancel(orderStatus(createdAt, cancelledAt, now))) return { error: "not_cancellable" };
  const decision = await consume(meta, "orderWrites", now);
  if (!decision.ok) return rateLimited("orderWrites", decision.retryAfterSec);
  const updated: StoredOrder = { ...current, cancelledAt: now.toISOString() };
  const next = orders.slice();
  next[index] = updated;
  await patchAppMetadata(userId, { orders: next, chat_limits: decision.limits });
  return summarize(updated, now);
}

export async function recordAudit(userId: string, entry: AuditEntry, now = new Date()): Promise<void> {
  const meta = await getAppMetadata(userId);
  const prior = Array.isArray(meta.audit) ? meta.audit : [];
  const kept: AuditEntry[] = [];
  for (const row of prior) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.ts !== "string" || typeof record.tool !== "string") continue;
    if (typeof record.summary !== "string" || typeof record.outcome !== "string") continue;
    kept.push({
      ts: record.ts,
      tool: record.tool,
      summary: record.summary,
      outcome: record.outcome,
    });
  }
  const next = [
    ...kept,
    {
      ts: entry.ts || now.toISOString(),
      tool: entry.tool.slice(0, 40),
      summary: entry.summary.slice(0, 80),
      outcome: entry.outcome.slice(0, 20),
    },
  ].slice(-AUDIT_CAP);
  await patchAppMetadata(userId, { audit: next });
}
