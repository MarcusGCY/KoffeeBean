export const CHAT_HOUR_LIMIT = 20;
export const CHAT_DAY_LIMIT = 60;
export const CART_WRITE_HOUR_LIMIT = 30;
export const ORDER_WRITE_HOUR_LIMIT = 10;
export const CHAT_HOUR_MS = 60 * 60 * 1000;
export const CHAT_DAY_MS = 24 * CHAT_HOUR_MS;

export const CHAT_RATE_LIMIT_MESSAGE = "Too many messages. Please try again in a little while.";
export const CART_RATE_LIMIT_MESSAGE = "Too many cart updates. Please try again in a little while.";
export const ORDER_RATE_LIMIT_MESSAGE = "Too many order updates. Please try again in a little while.";

export type LimitKind = "messages" | "cartWrites" | "orderWrites";

/** Timestamps live under the app_metadata `chat_limits` key, including cart and order writes. */
export type ChatLimits = {
  messages: number[];
  cartWrites: number[];
  orderWrites: number[];
};

export type RateLimited = {
  error: "rate_limited";
  message: string;
  retryAfterSec: number;
};

export type SlotDecision =
  | { ok: true; limits: ChatLimits }
  | { ok: false; retryAfterSec: number; limits: ChatLimits };

function stamps(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)).sort((a, b) => a - b);
}

export function normalizeLimits(value: unknown): ChatLimits {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    messages: stamps(record.messages),
    cartWrites: stamps(record.cartWrites),
    orderWrites: stamps(record.orderWrites),
  };
}

function retryAfter(oldest: number | undefined, windowMs: number, at: number): number {
  if (oldest === undefined) return Math.ceil(windowMs / 1000);
  return Math.max(1, Math.ceil((windowMs - (at - oldest)) / 1000));
}

/**
 * Prune the windows and, when allowed, append `now`.
 * The returned `limits` object is the full `chat_limits` value to patch.
 * Auth0 replaces that whole key, so cart and order stamps travel with chat stamps.
 */
export function takeSlot(limits: ChatLimits, kind: LimitKind, now: number): SlotDecision {
  const next: ChatLimits = {
    messages: limits.messages.filter((ts) => now - ts < CHAT_DAY_MS),
    cartWrites: limits.cartWrites.filter((ts) => now - ts < CHAT_HOUR_MS),
    orderWrites: limits.orderWrites.filter((ts) => now - ts < CHAT_HOUR_MS),
  };

  if (kind === "messages") {
    const hour = next.messages.filter((ts) => now - ts < CHAT_HOUR_MS);
    if (hour.length >= CHAT_HOUR_LIMIT) {
      return { ok: false, retryAfterSec: retryAfter(hour[0], CHAT_HOUR_MS, now), limits: next };
    }
    if (next.messages.length >= CHAT_DAY_LIMIT) {
      return { ok: false, retryAfterSec: retryAfter(next.messages[0], CHAT_DAY_MS, now), limits: next };
    }
    next.messages = [...next.messages, now];
    return { ok: true, limits: next };
  }

  const bucket = kind === "cartWrites" ? next.cartWrites : next.orderWrites;
  const cap = kind === "cartWrites" ? CART_WRITE_HOUR_LIMIT : ORDER_WRITE_HOUR_LIMIT;
  if (bucket.length >= cap) {
    return { ok: false, retryAfterSec: retryAfter(bucket[0], CHAT_HOUR_MS, now), limits: next };
  }
  const stamped = [...bucket, now];
  if (kind === "cartWrites") next.cartWrites = stamped;
  else next.orderWrites = stamped;
  return { ok: true, limits: next };
}

export function rateLimited(kind: "cartWrites" | "orderWrites", retryAfterSec: number): RateLimited {
  return {
    error: "rate_limited",
    message: kind === "cartWrites" ? CART_RATE_LIMIT_MESSAGE : ORDER_RATE_LIMIT_MESSAGE,
    retryAfterSec,
  };
}
