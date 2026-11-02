import { describe, expect, it } from "vitest";
import {
  CART_WRITE_HOUR_LIMIT,
  CHAT_DAY_LIMIT,
  CHAT_DAY_MS,
  CHAT_HOUR_LIMIT,
  CHAT_HOUR_MS,
  ORDER_WRITE_HOUR_LIMIT,
  normalizeLimits,
  takeSlot,
  type ChatLimits,
} from "@/lib/limits";

const empty = (): ChatLimits => ({ messages: [], cartWrites: [], orderWrites: [] });

describe("limits", () => {
  const now = 1_700_000_000_000;

  it("allows 20 chat messages an hour and blocks the next one", () => {
    let limits = empty();
    for (let i = 0; i < CHAT_HOUR_LIMIT; i++) {
      const decision = takeSlot(limits, "messages", now + i);
      expect(decision.ok).toBe(true);
      if (decision.ok) limits = decision.limits;
    }
    const blocked = takeSlot(limits, "messages", now + CHAT_HOUR_LIMIT);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("blocks the 61st message in a day even when the hour window is clear", () => {
    const limits = normalizeLimits({
      messages: Array.from({ length: CHAT_DAY_LIMIT }, (_, i) => now - CHAT_HOUR_MS - i),
      cartWrites: [now],
      orderWrites: [],
    });
    const blocked = takeSlot(limits, "messages", now);
    expect(blocked.ok).toBe(false);
    expect(blocked.limits.cartWrites).toEqual([now]);
  });

  it("drops chat stamps older than a day and keeps cart write stamps on the same key", () => {
    const limits = normalizeLimits({
      messages: [now - CHAT_DAY_MS - 1],
      cartWrites: [now - 1000],
      orderWrites: [],
    });
    const decision = takeSlot(limits, "messages", now);
    expect(decision.ok).toBe(true);
    expect(decision.limits.messages).toEqual([now]);
    expect(decision.limits.cartWrites).toEqual([now - 1000]);
  });

  it("caps cart and order writes per hour", () => {
    const cart = takeSlot(
      normalizeLimits({ cartWrites: Array.from({ length: CART_WRITE_HOUR_LIMIT }, () => now) }),
      "cartWrites",
      now,
    );
    expect(cart.ok).toBe(false);
    const order = takeSlot(
      normalizeLimits({ orderWrites: Array.from({ length: ORDER_WRITE_HOUR_LIMIT }, () => now - 10) }),
      "orderWrites",
      now,
    );
    expect(order.ok).toBe(false);
    if (!order.ok) expect(order.limits.orderWrites).toHaveLength(ORDER_WRITE_HOUR_LIMIT);
  });
});
