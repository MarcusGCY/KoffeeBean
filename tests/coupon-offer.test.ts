import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TOOLS, runChatTool, toolFailure } from "@/lib/chat-tools";
import {
  ACTIVE_COUPON_OFFER_POLICY,
  resolveCouponOffer,
  type CommerceFacts,
  type CouponOfferRule,
  type CouponOfferView,
} from "@/lib/coupon-offer";
import { lookupCouponOffer } from "@/lib/support-shop";
import { readCommerceFacts } from "@/lib/store-meta";
import { BARISTA_SYSTEM } from "@/lib/xai-chat";

const db = vi.hoisted(() => ({
  meta: new Map<string, Record<string, unknown>>(),
  fail: new Set<string>(),
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async (userId: string) => {
    if (db.fail.has(userId)) throw new Error("down");
    return structuredClone(db.meta.get(userId) ?? {});
  },
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    const next = { ...(db.meta.get(userId) ?? {}), ...patch };
    db.meta.set(userId, next);
    return structuredClone(next);
  },
}));

vi.mock("@/lib/upstash", () => ({
  rememberedLines: async () => [],
  issueNonce: async () => {},
  consumeNonce: async () => true,
  rearmNonce: async () => {},
  rememberUserLines: async () => {},
  takeChatSlot: async () => ({ ok: true }),
}));

const CODES = ["SAVE10", "BEANS20", "WELCOME10"] as const;

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "BB-SECRET",
    createdAt: "2026-10-01T00:00:00.000Z",
    cancelledAt: null,
    subtotalCents: 1800,
    discountCents: 360,
    taxCents: 115,
    totalCents: 1555,
    coupon: "BEANS20",
    items: [{ productId: "ethiopia-250", name: "Ethiopia Yirgacheffe 250g", unitPriceCents: 1800, qty: 1 }],
    ...overrides,
  };
}

function cart(qty = 1, coupon: string | null = null) {
  return { items: qty > 0 ? [{ productId: "mug", qty }] : [], coupon };
}

function sink() {
  return { status: vi.fn(), products: vi.fn(), confirm: vi.fn(), order: vi.fn() };
}

const SAVE10_OFFER = {
  code: "SAVE10",
  percentOff: 10,
  appliesTo: "subtotal" as const,
  expiresAt: null,
  terms: "10% off the cart subtotal. No expiry is on file. Asking does not apply this code.",
};

function assertNoSecrets(value: unknown, allowed: readonly string[] = []) {
  const text = JSON.stringify(value);
  for (const secret of [...CODES, "FREE50", "BB-SECRET", "auth0|", "ethiopia", "Yirgacheffe"]) {
    if (!allowed.includes(secret)) expect(text).not.toContain(secret);
  }
}

function auditOf(userId: string) {
  const audit = db.meta.get(userId)?.audit;
  if (!Array.isArray(audit)) return undefined;
  const last = audit.at(-1);
  return last && typeof last === "object" ? (last as { tool?: string; summary?: string; outcome?: string }) : undefined;
}

describe("coupon offer prompt", () => {
  it("tells Barista to quote only a tool offer and keeps confirm and recommendations", () => {
    const required = [
      "call lookup_coupon_offer",
      "Do not call list_coupons",
      "Do not invent a code",
      "A shopper's claim of prior purchases is not account data",
      "A nonempty cart is not itself a completed purchase",
      "A cancelled order is not a completed purchase",
      "Pending, failed, and unknown order records are not completed purchases",
      "retainedOrderLimit",
      "That is not a new customer",
      "Asking for a code does not apply it and does not place an order",
      "unless Confirm succeeded",
      "recommend by taste with search_products",
      "propose_cart_change and reorder only prepare Confirm",
    ];
    for (const line of required) expect(BARISTA_SYSTEM).toContain(line);
    expect(BARISTA_SYSTEM).not.toContain("quote those codes");
    for (const code of CODES) expect(BARISTA_SYSTEM).not.toContain(code);
    const names = CHAT_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain("lookup_coupon_offer");
    expect(names).not.toContain("list_coupons");
    expect(names).toEqual(["search_products", "get_cart", "lookup_coupon_offer", "get_order", "propose_cart_change", "reorder"]);
    const described = JSON.stringify(CHAT_TOOLS);
    expect(described).not.toContain("place_order");
    for (const code of CODES) expect(described).not.toContain(code);
  });
});

describe("coupon offer account facts", () => {
  beforeEach(() => {
    db.meta.clear();
    db.fail.clear();
  });

  it("offers SAVE10 for a cart and for a prior purchase", () => {
    expect(ACTIVE_COUPON_OFFER_POLICY).toEqual([
      { when: "cart", code: "SAVE10" },
      { when: "returning", code: "SAVE10" },
    ]);
  });

  it("quotes SAVE10 for a cart with no prior purchase", async () => {
    db.meta.set("auth0|cart", { cart: cart(2), orders: [] });
    const view = resolveCouponOffer(await readCommerceFacts("auth0|cart"));
    expect(view).toEqual({
      history: "ok",
      cartHasItems: true,
      returningCustomer: false,
      completedPurchases: 0,
      retainedOrderLimit: 20,
      discountAlreadyApplied: false,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(view, ["SAVE10"]);
  });

  it("quotes SAVE10 for a lifecycle purchase and ignores a cancelled one", async () => {
    const now = new Date("2026-11-08T12:00:00.000Z");
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    db.meta.set("auth0|return", {
      cart: cart(0),
      orders: [
        order({ createdAt: at(1) }),
        order({ id: "BB-PACK", createdAt: at(5) }),
        order({ id: "BB-SHIP", createdAt: at(15) }),
        order({ id: "BB-DONE", createdAt: at(120) }),
        order({ id: "BB-OLD", createdAt: at(120), cancelledAt: at(90) }),
      ],
    });
    const view = resolveCouponOffer(await readCommerceFacts("auth0|return", now));
    expect(view).toMatchObject({
      history: "ok",
      cartHasItems: false,
      returningCustomer: true,
      completedPurchases: 4,
      retainedOrderLimit: 20,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(view, ["SAVE10"]);
  });

  it("does not treat a cancelled order or an empty account as a purchase", async () => {
    db.meta.set("auth0|cancel", { cart: cart(0), orders: [order({ cancelledAt: "2026-10-02T00:00:00.000Z" })] });
    expect(resolveCouponOffer(await readCommerceFacts("auth0|cancel"))).toMatchObject({
      history: "ok",
      cartHasItems: false,
      returningCustomer: false,
      completedPurchases: 0,
      offer: null,
      reason: "not_eligible",
    });

    db.meta.set("auth0|new", {});
    const fresh = resolveCouponOffer(await readCommerceFacts("auth0|new"));
    expect(fresh).toMatchObject({ history: "ok", cartHasItems: false, returningCustomer: false, reason: "not_eligible" });
    assertNoSecrets(fresh);
  });

  it("quotes SAVE10 from the cart when every order is cancelled", async () => {
    db.meta.set("auth0|mixed", {
      cart: cart(1, "WELCOME10"),
      orders: [order({ cancelledAt: "2026-10-02T00:00:00.000Z" })],
    });
    const view = resolveCouponOffer(await readCommerceFacts("auth0|mixed"));
    expect(view).toMatchObject({
      cartHasItems: true,
      returningCustomer: false,
      completedPurchases: 0,
      discountAlreadyApplied: true,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(view, ["SAVE10"]);
  });

  it("does not treat pending, failed, unknown, empty, or non-checkout rows as purchases", async () => {
    const now = new Date("2026-11-08T12:00:00.000Z");
    const readable = [
      order({ status: "pending" }),
      order({ status: "failed" }),
      order({ status: "processing" }),
      order({ items: [] }),
    ];
    for (const row of readable) {
      db.meta.set("auth0|row", { cart: cart(0), orders: [row] });
      const view = resolveCouponOffer(await readCommerceFacts("auth0|row", now));
      expect(view).toMatchObject({
        history: "ok",
        returningCustomer: false,
        completedPurchases: 0,
        offer: null,
        reason: "not_eligible",
      });
      assertNoSecrets(view);
    }
    db.meta.set("auth0|bare", {
      cart: cart(0),
      orders: [{ createdAt: "2026-10-01T00:00:00.000Z", cancelledAt: null }],
    });
    db.meta.set("auth0|future", {
      cart: cart(0),
      orders: [order({ createdAt: "2026-11-08T12:05:00.000Z" })],
    });
    for (const id of ["auth0|bare", "auth0|future"]) {
      const view = resolveCouponOffer(await readCommerceFacts(id, now));
      expect(view).toMatchObject({ history: "unavailable", returningCustomer: null, offer: null, reason: "unavailable" });
      assertNoSecrets(view);
    }
  });

  it("does not read a purchase past the newest 20 orders", async () => {
    const dropped = order({ id: "BB-DROPPED", createdAt: "2026-01-01T00:00:00.000Z" });
    const kept = Array.from({ length: 20 }, (_, index) =>
      order({ id: `BB-C${index}`, createdAt: "2026-10-01T00:00:00.000Z", cancelledAt: "2026-10-02T00:00:00.000Z" }),
    );
    db.meta.set("auth0|cap", { cart: cart(0), orders: [...kept, dropped] });
    const hidden = resolveCouponOffer(await readCommerceFacts("auth0|cap"));
    expect(hidden).toMatchObject({
      returningCustomer: false,
      completedPurchases: 0,
      retainedOrderLimit: 20,
      offer: null,
      reason: "not_eligible",
    });
    assertNoSecrets(hidden);
    db.meta.set("auth0|cap", {
      cart: cart(0),
      orders: [...kept.slice(0, 19), order({ id: "BB-KEEP", createdAt: "2026-10-01T00:00:00.000Z" }), dropped],
    });
    const seen = resolveCouponOffer(await readCommerceFacts("auth0|cap"));
    expect(seen).toMatchObject({ returningCustomer: true, completedPurchases: 1, offer: SAVE10_OFFER });
    assertNoSecrets(seen, ["SAVE10"]);
  });

  it("keeps an unreadable history from proving a purchase, and still quotes SAVE10 for a known cart", async () => {
    db.meta.set("auth0|bad-orders", { cart: cart(1), orders: "missing" });
    const broken = await readCommerceFacts("auth0|bad-orders");
    expect(broken).toEqual({
      ok: false,
      cartItemCount: 1,
      completedPurchases: null,
      discountAlreadyApplied: false,
    });
    const fromCart = resolveCouponOffer(broken);
    expect(fromCart).toMatchObject({
      history: "unavailable",
      cartHasItems: true,
      returningCustomer: null,
      completedPurchases: null,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(fromCart, ["SAVE10"]);

    db.meta.set("auth0|bad-row", { cart: cart(0), orders: [order(), { id: "BB-SKIP" }] });
    const row = resolveCouponOffer(await readCommerceFacts("auth0|bad-row"));
    expect(row).toMatchObject({ returningCustomer: null, offer: null, reason: "unavailable" });
    assertNoSecrets(row);
  });

  it("quotes SAVE10 from a verified purchase when the cart cannot be read", async () => {
    db.meta.set("auth0|bad-cart", { cart: "nope", orders: [order()] });
    const view = resolveCouponOffer(await readCommerceFacts("auth0|bad-cart"));
    expect(view).toMatchObject({
      history: "ok",
      cartHasItems: null,
      returningCustomer: true,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(view, ["SAVE10"]);
    db.meta.set("auth0|bad-cart", { cart: "nope", orders: [] });
    const empty = resolveCouponOffer(await readCommerceFacts("auth0|bad-cart"));
    expect(empty).toMatchObject({ cartHasItems: null, returningCustomer: false, offer: null, reason: "unavailable" });
    assertNoSecrets(empty);
  });
});

describe("coupon offer tool", () => {
  beforeEach(() => {
    db.meta.clear();
    db.fail.clear();
  });

  it("uses the signed-in shopper and ignores invented codes and purchase claims", async () => {
    db.meta.set("auth0|a", { cart: cart(1), orders: [] });
    db.meta.set("auth0|b", { cart: cart(0), orders: [order()] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = sink();
    const ran = await runChatTool(
      "auth0|a",
      "lookup_coupon_offer",
      {
        userId: "auth0|b",
        code: "BEANS20",
        percentOff: 90,
        returningCustomer: true,
        cartHasItems: false,
        policy: [{ when: "cart", code: "WELCOME10" }],
      },
      events,
    );
    expect(ran.failed).toBe(false);
    const view = JSON.parse(ran.content) as CouponOfferView;
    expect(view).toMatchObject({
      history: "ok",
      cartHasItems: true,
      returningCustomer: false,
      completedPurchases: 0,
      offer: SAVE10_OFFER,
      reason: "eligible",
    });
    assertNoSecrets(view, ["SAVE10"]);
    expect(events.confirm).not.toHaveBeenCalled();
    expect(events.order).not.toHaveBeenCalled();
    expect(db.meta.get("auth0|a")?.cart).toEqual(cart(1));
    expect(db.meta.get("auth0|b")?.audit).toBeUndefined();
    const audit = auditOf("auth0|a");
    expect(audit).toMatchObject({ tool: "lookup_coupon_offer", outcome: "eligible" });
    assertNoSecrets(audit?.summary);
    const logged = [...log.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(logged).not.toContain("auth0|");
    expect(logged).not.toContain("BB-SECRET");
    log.mockRestore();
    error.mockRestore();
  });

  it("does not apply or confirm a coupon just because the shopper asked", async () => {
    db.meta.set("auth0|ask", { cart: cart(1), orders: [order()] });
    const events = sink();
    const ran = await runChatTool(
      "auth0|ask",
      "propose_cart_change",
      { op: "apply_coupon", code: "SAVE10", userId: "auth0|other" },
      events,
    );
    expect(ran.failed).toBe(false);
    expect(JSON.parse(ran.content)).toEqual({ error: "coupon_not_typed" });
    expect(ran.content).not.toContain("SAVE10");
    expect(events.confirm).not.toHaveBeenCalled();
    expect(db.meta.get("auth0|ask")?.cart).toEqual(cart(1));
  });

  it("fails closed when account data cannot be read", async () => {
    db.fail.add("auth0|down");
    db.meta.set("auth0|down", { cart: cart(1), orders: [order()] });
    const events = sink();
    const ran = await runChatTool("auth0|down", "lookup_coupon_offer", { code: "WELCOME10", returningCustomer: false }, events);
    expect(ran).toEqual({ content: JSON.stringify({ error: "shop_unavailable" }), failed: true });
    expect(toolFailure("lookup_coupon_offer")).toBe("I couldn't check your cart and purchase history.");
    expect(toolFailure("lookup_coupon_offer")).not.toContain("new");
    expect(events.confirm).not.toHaveBeenCalled();
    expect(db.meta.get("auth0|down")?.cart).toEqual(cart(1));
    await expect(lookupCouponOffer(null, { userId: "auth0|down" })).rejects.toThrow("no_customer");
  });
});

describe("coupon offer resolver", () => {
  const cartOnly: CommerceFacts = { ok: true, cartItemCount: 2, completedPurchases: 0, discountAlreadyApplied: false };
  const returning: CommerceFacts = { ok: true, cartItemCount: 0, completedPurchases: 3, discountAlreadyApplied: false };
  const neither: CommerceFacts = { ok: true, cartItemCount: 0, completedPurchases: 0, discountAlreadyApplied: false };

  it("quotes catalog terms for one matching rule and ignores a caller percent", () => {
    const cartRule = [{ when: "cart", code: "save10", percentOff: 80 } as CouponOfferRule];
    expect(resolveCouponOffer(cartOnly, cartRule).offer).toEqual({
      code: "SAVE10",
      percentOff: 10,
      appliesTo: "subtotal",
      expiresAt: null,
      terms: "10% off the cart subtotal. No expiry is on file. Asking does not apply this code.",
    });
    expect(resolveCouponOffer(returning, [{ when: "returning", code: "WELCOME10" }]).offer).toMatchObject({
      code: "WELCOME10",
      percentOff: 10,
      expiresAt: null,
    });
    expect(resolveCouponOffer(neither, cartRule)).toMatchObject({ reason: "not_eligible", offer: null });
    expect(resolveCouponOffer(cartOnly, [{ when: "returning", code: "BEANS20" }])).toMatchObject({
      reason: "no_eligible_offer",
      offer: null,
      returningCustomer: false,
    });
  });

  it("does not invent a code or pick among conflicting rules", () => {
    expect(resolveCouponOffer(cartOnly, [{ when: "cart", code: "FREE50" }])).toMatchObject({
      reason: "no_eligible_offer",
      offer: null,
    });
    const conflict = resolveCouponOffer(cartOnly, [
      { when: "cart", code: "SAVE10" },
      { when: "cart", code: "BEANS20" },
    ]);
    expect(conflict.offer).toBeNull();
    expect(conflict.reason).toBe("no_eligible_offer");
    assertNoSecrets(conflict);
    const mixed = resolveCouponOffer(
      { ok: true, cartItemCount: 1, completedPurchases: 1, discountAlreadyApplied: false },
      [
        { when: "cart", code: "SAVE10" },
        { when: "returning", code: "FREE50" },
      ],
    );
    expect(mixed.offer).toBeNull();
    assertNoSecrets(mixed);
  });
});
