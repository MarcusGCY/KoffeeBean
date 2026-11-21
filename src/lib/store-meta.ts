import type { CartItem } from "./types";
import { addItem, getProduct, removeItem, total } from "./cart";
import { checkout, type Order } from "./checkout";
import { ORDER_HISTORY_LIMIT, type CommerceFacts } from "./coupon-offer";
import { findCoupon } from "./coupons";
import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { biDbConfigured } from "./bi-db";
import { biHashConfigured } from "./bi-hash";
import { biProfileFromMeta, type BiProfileFacts } from "./bi-profiles";
import { emitBi, isTestShopper, trackOrderCancelled, trackOrderPlaced, trackProfile } from "./bi-track";
import { normalizeProfile, profileIsStale, profilePatch, type BaristaProfile } from "./barista-profile";
import { normalizeLimits, rateLimited, takeSlot, type RateLimited } from "./limits";
import { canCancel, orderStatus, undoDeadline } from "./order-status";
import { expireStale, normalizeActivity, undoActivityForOrder } from "./agent-activity";
import type { ActivityEntry } from "./agent-activity-text";
import { DEFAULT_AGENT_CAP_CENTS } from "./agent-cap";
import { isDemoShopperSub } from "./demo-shopper";
import { createTestPayment, readTestPayment, type TestPayment } from "./test-payment";
import type { NudgeOrder } from "./reorder-nudge";
import type { AgentPrefs, CartSnapshot, OrderDetail, OrderSummary, ShopperFlags } from "./store-types";

/**
 * Per-shopper cart, orders, and audit stored in Auth0 `app_metadata`.
 * Auth0 merges only top-level keys, so each patch sends the full value of
 * every key it changes and omits the rest. Two writers that patch the same
 * key are last-write-wins (a lost cart line or a lost quota stamp is acceptable
 * for this demo).
 *
 * Keys: `cart`, `orders` (newest 20), `chat_limits`, `audit` (newest 50),
 * `is_test` (boolean), `agent_prefs` (see `normalizeAgentPrefs`), `barista_profile` (see
 * `barista-profile.ts`; rewritten in the same patch whenever orders are placed or cancelled).
 */

const ORDER_CAP = ORDER_HISTORY_LIMIT;
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
  /** Set only on seeded demo orders (`bi-demo-seed`). Kept when an order is rewritten. */
  demo?: true;
  /** Test-mode payment record. No processor or card data is ever stored. */
  payment?: TestPayment;
  /** Set when an agent (Barista) placed the order on the shopper's confirmed OK. */
  placedBy?: "barista";
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
    const payment = readTestPayment(record.payment);
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
      ...(record.demo === true ? { demo: true as const } : {}),
      ...(payment ? { payment } : {}),
      ...(record.placedBy === "barista" ? { placedBy: "barista" as const } : {}),
    });
  }
  return orders.slice(0, ORDER_CAP);
}

export { DEFAULT_AGENT_CAP_CENTS };

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : undefined;
}

/**
 * Reads the `agent_prefs` key. Missing or malformed fields fall back to defaults,
 * so shoppers who have no key normalize to `{ capCents: 6000, askEveryOrder: true }`.
 * `askEveryOrder` is locked to true for the MVP whatever is stored.
 */
export function normalizeAgentPrefs(value: unknown): AgentPrefs {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const cap = finite(record.capCents);
  const prefs: AgentPrefs = {
    capCents: cap != null && Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_AGENT_CAP_CENTS,
    askEveryOrder: true,
  };
  const consentAt = validTimestamp(record.consentAt);
  if (consentAt) prefs.consentAt = consentAt;
  const snoozeUntil = validTimestamp(record.snoozeUntil);
  if (snoozeUntil) prefs.snoozeUntil = snoozeUntil;
  if (typeof record.lastNudgeSession === "string" && record.lastNudgeSession) {
    prefs.lastNudgeSession = record.lastNudgeSession;
  }
  if (typeof record.paused === "boolean") prefs.paused = record.paused;
  return prefs;
}

/** `is_test` is true only for a stored boolean true. */
export function normalizeShopperFlags(meta: Record<string, unknown>): ShopperFlags {
  return { isTest: isTestShopper(meta), agentPrefs: normalizeAgentPrefs(meta.agent_prefs) };
}

export async function getShopperFlags(userId: string): Promise<ShopperFlags> {
  return normalizeShopperFlags(await getAppMetadata(userId));
}

export type NudgeInputs = {
  flags: ShopperFlags;
  /** True for `is_test` shoppers and the configured demo shopper. */
  demo: boolean;
  orders: (NudgeOrder & { id: string })[];
};

/** One Management API read: this shopper's flags and retained orders, as the nudge engine reads them. */
export async function readNudgeInputs(userId: string): Promise<NudgeInputs> {
  const meta = await getAppMetadata(userId);
  const flags = normalizeShopperFlags(meta);
  return {
    flags,
    demo: flags.isTest || isDemoShopperSub(userId),
    orders: nudgeOrders(readOrders(meta)),
  };
}

/**
 * The traits mirrored to `bi_customer_profiles`. `isTest` is the one `isTestShopper` check plus the configured
 * demo shopper. `profile` is the profile just written, or undefined to use the stored one.
 */
function biFacts(
  userId: string,
  meta: Record<string, unknown>,
  orders: readonly StoredOrder[],
  now: Date,
  profile?: BaristaProfile,
): BiProfileFacts {
  return biProfileFromMeta(meta, orders, { isTest: isTestShopper(meta) || isDemoShopperSub(userId), now, profile });
}

/** After a change to location or profile settings: refreshes this shopper's BI row, after the response. */
export function emitBiProfile(userId: string, now = new Date()): void {
  emitBi(async () => {
    if (!biDbConfigured() || !biHashConfigured()) return;
    const meta = await getAppMetadata(userId);
    await trackProfile({ sub: userId }, biFacts(userId, meta, readOrders(meta), now));
  });
}

/** The shopper's retained orders as the nudge and profile engines read them. */
export function retainedNudgeOrders(meta: Record<string, unknown>): (NudgeOrder & { id: string })[] {
  return nudgeOrders(readOrders(meta));
}

function nudgeOrders(orders: readonly StoredOrder[]): (NudgeOrder & { id: string })[] {
  return orders.map((order) => ({
    id: order.id,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    items: order.items.map((item) => ({ productId: item.productId, qty: item.qty })),
  }));
}

/**
 * This shopper's Barista profile. Returned as stored while it is under 24 hours old. A missing or older
 * profile is recomputed from retained orders and saved (one extra patch of only that key). A shopper with
 * personalization off keeps the stored `off` profile and nothing is recomputed. Null when there is nothing to know yet.
 */
export async function readBaristaProfile(userId: string, now = new Date()): Promise<BaristaProfile | null> {
  const meta = await getAppMetadata(userId);
  const stored = normalizeProfile(meta.barista_profile);
  if (stored?.off || (stored && !profileIsStale(stored, now))) return stored;
  const patch = profilePatch(meta, nudgeOrders(readOrders(meta)), now);
  if (!patch.barista_profile) return stored;
  await patchAppMetadata(userId, patch);
  return patch.barista_profile;
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
    ...(order.payment ? { payment: order.payment } : {}),
    ...(order.placedBy ? { placedBy: order.placedBy } : {}),
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

async function consume(meta: Record<string, unknown>, kind: "cartWrites" | "orderWrites" | "productViews", now: Date) {
  return takeSlot(normalizeLimits(meta.chat_limits), kind, now.getTime());
}

export async function getCart(userId: string): Promise<CartSnapshot> {
  const cart = readCart(await getAppMetadata(userId));
  return snapshot(cart.items, cart.coupon);
}

function cartFacts(meta: Record<string, unknown>): { ok: true; itemCount: number; discountAlreadyApplied: boolean } | { ok: false } {
  if (!Object.hasOwn(meta, "cart") || meta.cart == null) return { ok: true, itemCount: 0, discountAlreadyApplied: false };
  const cart = meta.cart;
  if (typeof cart !== "object" || Array.isArray(cart)) return { ok: false };
  const record = cart as { items?: unknown; coupon?: unknown };
  if (record.items != null && !Array.isArray(record.items)) return { ok: false };
  const rows = Array.isArray(record.items) ? record.items : [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { ok: false };
    const line = row as { productId?: unknown; qty?: unknown };
    if (typeof line.productId !== "string" || !line.productId) return { ok: false };
    if (typeof line.qty !== "number" || !validQty(line.qty)) return { ok: false };
  }
  const code = typeof record.coupon === "string" ? record.coupon : "";
  const discountAlreadyApplied = Boolean(findCoupon(code));
  return { ok: true, itemCount: rows.length, discountAlreadyApplied };
}

const PURCHASE_STATUSES = new Set(["placed", "packed", "shipped", "delivered"]);

/**
 * A prior purchase is a stored checkout on the demo lifecycle.
 * `placed`, `packed`, `shipped`, and `delivered` count. `cancelled` does not.
 * An explicit `pending`, `failed`, or other status is not a purchase.
 * A row that is not a checkout record makes the list unreadable.
 * Only the newest `ORDER_CAP` rows are read.
 */
function classifyOrderRow(row: unknown, now: Date): "purchase" | "not_purchase" | "unreadable" {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "unreadable";
  const record = row as Record<string, unknown>;
  if ("status" in record) {
    if (typeof record.status !== "string") return "unreadable";
    if (record.status === "pending" || record.status === "failed" || record.status === "cancelled") return "not_purchase";
    if (!PURCHASE_STATUSES.has(record.status)) return "not_purchase";
  }
  if (typeof record.id !== "string" || record.id.trim() === "") return "unreadable";
  if (typeof record.createdAt !== "string") return "unreadable";
  const createdAt = new Date(record.createdAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.getTime() > now.getTime()) return "unreadable";
  const subtotalCents = finite(record.subtotalCents);
  const discountCents = finite(record.discountCents);
  const taxCents = finite(record.taxCents);
  const totalCents = finite(record.totalCents);
  if (subtotalCents == null || discountCents == null || taxCents == null || totalCents == null) return "unreadable";
  if (subtotalCents < 0 || discountCents < 0 || taxCents < 0 || totalCents < 0) return "unreadable";
  if (!Array.isArray(record.items)) return "unreadable";
  if (record.items.length === 0) return "not_purchase";
  for (const item of record.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "unreadable";
    const line = item as Record<string, unknown>;
    const unitPriceCents = finite(line.unitPriceCents);
    const qty = finite(line.qty);
    if (typeof line.productId !== "string" || !line.productId) return "unreadable";
    if (typeof line.name !== "string" || !line.name) return "unreadable";
    if (unitPriceCents == null || unitPriceCents < 0 || qty == null || !validQty(qty)) return "unreadable";
  }
  let cancelledAt: Date | null = null;
  if (record.cancelledAt != null) {
    if (typeof record.cancelledAt !== "string") return "unreadable";
    cancelledAt = new Date(record.cancelledAt);
    if (Number.isNaN(cancelledAt.getTime())) return "unreadable";
  }
  const derived = orderStatus(createdAt, cancelledAt, now);
  if ("status" in record && record.status !== derived) return "unreadable";
  if (derived === "cancelled") return "not_purchase";
  if (PURCHASE_STATUSES.has(derived)) return "purchase";
  return "unreadable";
}

function purchaseFacts(meta: Record<string, unknown>, now: Date): { ok: true; completedPurchases: number } | { ok: false } {
  if (!Object.hasOwn(meta, "orders") || meta.orders == null) return { ok: true, completedPurchases: 0 };
  if (!Array.isArray(meta.orders)) return { ok: false };
  let completedPurchases = 0;
  for (const row of meta.orders.slice(0, ORDER_CAP)) {
    const kind = classifyOrderRow(row, now);
    if (kind === "unreadable") return { ok: false };
    if (kind === "purchase") completedPurchases += 1;
  }
  return { ok: true, completedPurchases };
}

/**
 * Cart and purchase counts for this shopper's Auth0 `app_metadata` only.
 * A missing cart or orders key is an empty account. A value that cannot be
 * classified is unreadable and is not reported as zero. Orders are not returned.
 */
export async function readCommerceFacts(userId: string, now = new Date()): Promise<CommerceFacts> {
  const meta = await getAppMetadata(userId);
  const cart = cartFacts(meta);
  const purchases = purchaseFacts(meta, now);
  if (!cart.ok || !purchases.ok) {
    return {
      ok: false,
      cartItemCount: cart.ok ? cart.itemCount : null,
      completedPurchases: purchases.ok ? purchases.completedPurchases : null,
      discountAlreadyApplied: cart.ok ? cart.discountAlreadyApplied : null,
    };
  }
  return {
    ok: true,
    cartItemCount: cart.itemCount,
    completedPurchases: purchases.completedPurchases,
    discountAlreadyApplied: cart.discountAlreadyApplied,
  };
}

/**
 * Takes one hourly `productViews` slot from `chat_limits`, the same limiter as
 * cart writes. On success also reports whether the shopper is test traffic,
 * from the metadata this call already read.
 */
export async function takeProductViewSlot(
  userId: string,
  now = new Date(),
): Promise<{ ok: true; isTest: boolean } | RateLimited> {
  const meta = await getAppMetadata(userId);
  const decision = await consume(meta, "productViews", now);
  if (!decision.ok) return rateLimited("productViews", decision.retryAfterSec);
  await patchAppMetadata(userId, { chat_limits: decision.limits });
  return { ok: true, isTest: isTestShopper(meta, userId) };
}

/** Adds via addItem. */
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

/** Adds several lines in one write (one cart-write slot). Nothing is saved unless every line is valid. */
export async function addManyToCart(
  userId: string,
  lines: readonly { productId: string; qty: number }[],
  now = new Date(),
): Promise<CartSnapshot | { error: "qty_limit" } | { error: "unknown_product" } | RateLimited> {
  if (lines.length === 0) return { error: "qty_limit" };
  const meta = await getAppMetadata(userId);
  const current = readCart(meta);
  let items = current.items;
  for (const line of lines) {
    if (!getProduct(line.productId)) return { error: "unknown_product" };
    if (!validQty(line.qty)) return { error: "qty_limit" };
    for (let i = 0; i < line.qty; i++) items = addItem(items, line.productId);
  }
  if (items.some((item) => item.quantity > 99)) return { error: "qty_limit" };
  const decision = await consume(meta, "cartWrites", now);
  if (!decision.ok) return rateLimited("cartWrites", decision.retryAfterSec);
  await patchAppMetadata(userId, {
    cart: storedCart(items, current.coupon),
    chat_limits: decision.limits,
  });
  return snapshot(items, current.coupon);
}

/** Sets an absolute quantity using addItem and removeItem. */
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
  opts: { placedBy?: "barista" } = {},
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
    payment: createTestPayment(),
    ...(opts.placedBy ? { placedBy: opts.placedBy } : {}),
    items: draft.items.flatMap((item) => {
      const product = getProduct(item.productId);
      if (!product) return [];
      return [{ productId: item.productId, name: product.name, unitPriceCents: product.price, qty: item.quantity }];
    }),
  };
  const nextOrders = [stored, ...existing].slice(0, ORDER_CAP);
  const changes = { orders: nextOrders, cart: storedCart([], null), chat_limits: decision.limits };
  const learned = profilePatch(meta, nudgeOrders(nextOrders), now, changes);
  await patchAppMetadata(userId, { ...changes, ...learned });
  const facts = biFacts(userId, meta, nextOrders, now, learned.barista_profile);
  const testCtx = isTestShopper(meta, userId) ? { isTest: true } : {};
  emitBi(() => trackOrderPlaced({ sub: userId, ...testCtx, profile: facts }, stored));
  return summarize(stored, now);
}

export type ActivityRow = ActivityEntry & {
  /** When the linked order can no longer be undone, while it still can be. */
  undoUntil: string | null;
};

/** One Management API read: this shopper's agent activity, with the undo deadline of each still-cancellable order. */
export async function readActivityView(userId: string, now = new Date()): Promise<{ entries: ActivityRow[]; demo: boolean }> {
  const meta = await getAppMetadata(userId);
  const orders = readOrders(meta);
  const entries = expireStale(normalizeActivity(meta.agent_activity), now).map((entry) => {
    const order = entry.orderId ? orders.find((row) => row.id === entry.orderId) : undefined;
    const createdAt = order ? new Date(order.createdAt) : null;
    const cancelledAt = order?.cancelledAt ? new Date(order.cancelledAt) : null;
    const cancellable = createdAt ? canCancel(orderStatus(createdAt, cancelledAt, now)) : false;
    return { ...entry, undoUntil: createdAt && cancellable ? undoDeadline(createdAt).toISOString() : null };
  });
  return { entries, demo: normalizeShopperFlags(meta).isTest || isDemoShopperSub(userId) };
}

export async function listOrders(userId: string, now = new Date()): Promise<OrderSummary[]> {
  return readOrders(await getAppMetadata(userId)).map((order) => summarize(order, now));
}

/** One Management API read of this shopper's retained orders, including line items. */
export async function listOrderDetails(userId: string, now = new Date()): Promise<OrderDetail[]> {
  return readOrders(await getAppMetadata(userId)).map((order) => detail(order, now));
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
  const activity = undoActivityForOrder(normalizeActivity(meta.agent_activity), updated.id, now);
  const changes = { orders: next, chat_limits: decision.limits, ...(activity ? { agent_activity: activity } : {}) };
  const learned = profilePatch(meta, nudgeOrders(next), now, changes);
  await patchAppMetadata(userId, { ...changes, ...learned });
  const facts = biFacts(userId, meta, next, now, learned.barista_profile);
  const testCtx = isTestShopper(meta, userId) ? { isTest: true } : {};
  emitBi(() =>
    trackOrderCancelled(
      { sub: userId, ...testCtx, profile: facts },
      { id: updated.id, totalCents: updated.totalCents, cancelledAt: now.toISOString() },
    ),
  );
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
