import { signSupportToken } from "./token";

export type Principal = { principalId?: string } | null | undefined;

/**
 * Shopper id from the session principal only.
 * `input.userId` is ignored when the model sends one.
 */
export function customerId(auth: Principal, input: { userId?: unknown } | null | undefined): string {
  void input?.userId;
  const id = auth?.principalId?.trim() ?? "";
  if (!id) throw new Error("no_customer");
  return id;
}

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

function asJson(value: unknown): Json {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value as Json;
  }
  if (Array.isArray(value)) return value.map(asJson);
  if (typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value)) out[key] = asJson(item);
    return out;
  }
  return null;
}

async function shopFetch(userId: string, path: string, init?: RequestInit): Promise<Json> {
  const base = process.env.KOFFEEBEAN_URL?.trim().replace(/\/$/, "");
  const secret = process.env.SUPPORT_AGENT_SECRET?.trim();
  if (!base || !secret) return { error: "shop_unavailable" };
  const token = signSupportToken(userId, secret);
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    if (body && typeof body === "object" && !Array.isArray(body)) return asJson(body);
    return { error: "shop_error", status: response.status };
  }
  return asJson(body);
}

async function getJson(userId: string, path: string): Promise<Json> {
  return shopFetch(userId, path);
}

type ProposeBody = { [key: string]: Json };

/** Asks the shop for a signed confirm action. The shop does not change state here. */
function propose(auth: Principal, input: { userId?: unknown } | null | undefined, body: ProposeBody): Promise<Json> {
  return shopFetch(customerId(auth, input), "/api/agent/actions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function faqAnswer(auth: Principal, input: { userId?: unknown; question?: unknown }): Promise<Json> {
  void input.question;
  return getJson(customerId(auth, input), "/api/agent/faq");
}

export function listProducts(auth: Principal, input: { userId?: unknown }): Promise<Json> {
  return getJson(customerId(auth, input), "/api/agent/products");
}

export function viewCart(auth: Principal, input: { userId?: unknown }): Promise<Json> {
  return getJson(customerId(auth, input), "/api/agent/cart");
}

export function listMyOrders(auth: Principal, input: { userId?: unknown }): Promise<Json> {
  return getJson(customerId(auth, input), "/api/agent/orders");
}

export function proposeAddToCart(
  auth: Principal,
  input: { userId?: unknown; productId?: unknown; qty?: unknown },
): Promise<Json> {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 1;
  return propose(auth, input, { op: "add_to_cart", productId, qty });
}

export function proposeUpdateQty(
  auth: Principal,
  input: { userId?: unknown; productId?: unknown; qty?: unknown },
): Promise<Json> {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 0;
  return propose(auth, input, { op: "update_cart_qty", productId, qty });
}

export function proposeRemoveFromCart(
  auth: Principal,
  input: { userId?: unknown; productId?: unknown; qty?: unknown },
): Promise<Json> {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 1;
  return propose(auth, input, { op: "remove_from_cart", productId, qty });
}

export function proposeApplyCoupon(auth: Principal, input: { userId?: unknown; code?: unknown }): Promise<Json> {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  return propose(auth, input, { op: "apply_coupon", code });
}

export function proposePlaceOrder(auth: Principal, input: { userId?: unknown }): Promise<Json> {
  return propose(auth, input, { op: "place_order" });
}

export function proposeCancelOrder(auth: Principal, input: { userId?: unknown; orderId?: unknown }): Promise<Json> {
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  return propose(auth, input, { op: "cancel_order", orderId });
}

export function proposeReportProblem(auth: Principal, input: { userId?: unknown; message?: unknown }): Promise<Json> {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  return propose(auth, input, { op: "report_problem", message });
}

export function getOrderStatus(
  auth: Principal,
  input: { orderId?: unknown; userId?: unknown },
): Promise<Json> | { error: string } {
  const userId = customerId(auth, input);
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  if (!orderId || orderId.length > 40 || orderId.includes("/")) return { error: "invalid_order" };
  return getJson(userId, `/api/agent/orders/${encodeURIComponent(orderId)}`);
}
