import { beforeEach, describe, expect, it, vi } from "vitest";
import { CART_RATE_LIMIT_MESSAGE, CART_WRITE_HOUR_LIMIT } from "@/lib/limits";
import { addToCart, applyCoupon, getCart, placeOrder, recordAudit } from "@/lib/store-meta";

const db = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
  patches: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.patches.push(structuredClone(patch));
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

function order(id: string, createdAt: string) {
  return {
    id,
    createdAt,
    cancelledAt: null,
    subtotalCents: 1400,
    discountCents: 0,
    taxCents: 112,
    totalCents: 1512,
    coupon: null,
    items: [{ productId: "mug", name: "BeanBox Ceramic Mug", unitPriceCents: 1400, qty: 1 }],
  };
}

describe("store-meta", () => {
  beforeEach(() => {
    db.meta = {};
    db.patches = [];
  });

  it("patches cart and chat_limits and leaves other top-level keys in place", async () => {
    const now = new Date("2026-10-31T01:00:00.000Z");
    const messageAt = now.getTime() - 1000;
    db.meta = {
      orders: [order("BB-KEEP", "2026-10-31T00:00:00.000Z")],
      chat_limits: { messages: [messageAt], cartWrites: [], orderWrites: [] },
    };
    const cart = await addToCart("auth0|shopper", "mug", 2, now);
    expect(cart).toMatchObject({ items: [{ productId: "mug", qty: 2 }], coupon: null });
    expect(Object.keys(db.patches[0] ?? {}).sort()).toEqual(["cart", "chat_limits"]);
    expect(db.meta.orders).toEqual([order("BB-KEEP", "2026-10-31T00:00:00.000Z")]);
    expect(db.meta.chat_limits).toMatchObject({ messages: [messageAt] });
    expect(await getCart("auth0|shopper")).toMatchObject({ items: [{ productId: "mug", qty: 2 }] });
  });

  it("rejects a quantity outside 1..99 and does not write", async () => {
    expect(await addToCart("auth0|shopper", "mug", 0)).toEqual({ error: "qty_limit" });
    expect(await addToCart("auth0|shopper", "mug", 100)).toEqual({ error: "qty_limit" });
    db.meta = { cart: { items: [{ productId: "mug", qty: 99 }], coupon: null } };
    expect(await addToCart("auth0|shopper", "mug", 1)).toEqual({ error: "qty_limit" });
    expect(db.patches).toHaveLength(0);
  });

  it("still no-ops the planted tote id and does not write", async () => {
    const cart = await addToCart("auth0|shopper", "tote", 1);
    expect(cart).toMatchObject({ items: [] });
    expect(db.patches).toHaveLength(0);
  });

  it("keeps the newest 20 orders", async () => {
    const older = Array.from({ length: 20 }, (_, i) => order(`BB-OLD${String(i).padStart(2, "0")}`, new Date(1_000 + i).toISOString()));
    db.meta = { orders: older, cart: { items: [{ productId: "mug", qty: 1 }], coupon: null } };
    const placed = await placeOrder("auth0|shopper", new Date("2026-10-31T00:00:00.000Z"));
    expect(placed).toMatchObject({ id: expect.stringMatching(/^BB-/) });
    const orders = db.meta.orders as { id: string }[];
    expect(orders).toHaveLength(20);
    expect(orders[0]?.id).toBe((placed as { id: string }).id);
    expect(orders.map((item) => item.id)).not.toContain("BB-OLD19");
    expect(db.meta.cart).toEqual({ items: [], coupon: null });
  });

  it("stores a coupon the shop recognizes and refuses an unknown code without writing", async () => {
    const applied = await applyCoupon("auth0|shopper", "save10");
    expect(applied).toMatchObject({ coupon: "SAVE10", discountCents: 0 });
    db.patches = [];
    expect(await applyCoupon("auth0|shopper", "FREE")).toEqual({ error: "invalid_coupon" });
    expect(db.patches).toHaveLength(0);
  });

  it("returns a friendly cart write limit and does not change the cart", async () => {
    const now = new Date("2026-10-31T03:00:00.000Z");
    db.meta = {
      cart: { items: [], coupon: null },
      chat_limits: {
        messages: [],
        cartWrites: Array.from({ length: CART_WRITE_HOUR_LIMIT }, () => now.getTime()),
        orderWrites: [],
      },
    };
    const result = await addToCart("auth0|shopper", "mug", 1, now);
    expect(result).toMatchObject({ error: "rate_limited", message: CART_RATE_LIMIT_MESSAGE });
    expect(db.patches).toHaveLength(0);
    expect(db.meta.cart).toEqual({ items: [], coupon: null });
  });

  it("keeps the newest 50 audit rows and shortens the summary", async () => {
    db.meta = {
      audit: Array.from({ length: 50 }, (_, i) => ({ ts: `t${i}`, tool: "view_cart", summary: "s", outcome: "ok" })),
    };
    await recordAudit("auth0|shopper", { ts: "newest", tool: "view_cart", summary: "x".repeat(200), outcome: "ok" });
    const audit = db.meta.audit as { ts: string; summary: string }[];
    expect(audit).toHaveLength(50);
    expect(audit[0]?.ts).toBe("t1");
    expect(audit.at(-1)).toMatchObject({ ts: "newest", summary: "x".repeat(80) });
    expect(Object.keys(db.patches[0] ?? {})).toEqual(["audit"]);
  });
});
