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

async function getJson(userId: string, path: string): Promise<Json> {
  const base = process.env.KOFFEEBEAN_URL?.trim().replace(/\/$/, "");
  const secret = process.env.SUPPORT_AGENT_SECRET?.trim();
  if (!base || !secret) return { error: "shop_unavailable" };
  const token = signSupportToken(userId, secret);
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) return { error: "shop_error", status: response.status };
  return asJson(body);
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

export function getOrderStatus(
  auth: Principal,
  input: { orderId?: unknown; userId?: unknown },
): Promise<Json> | { error: string } {
  const userId = customerId(auth, input);
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  if (!orderId || orderId.length > 40 || orderId.includes("/")) return { error: "invalid_order" };
  return getJson(userId, `/api/agent/orders/${encodeURIComponent(orderId)}`);
}
