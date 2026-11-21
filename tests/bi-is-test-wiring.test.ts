import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
  patches: [] as Record<string, unknown>[],
}));
const getShopper = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shopper", () => ({ getShopper }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.patches.push(structuredClone(patch));
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

import { POST as viewPost } from "@/app/api/products/view/route";
import { POST as cartPost } from "@/app/api/cart/items/route";
import * as events from "@/lib/bi-events";
import { PRODUCT_VIEW_HOUR_LIMIT } from "@/lib/limits";
import { addToCart, cancelOrder, placeOrder } from "@/lib/store-meta";

const SUB = "auth0|shopper-1";
const DEMO_SUB = "auth0|demo-shopper";
const recordMock = vi.fn();

type Recorded = { type: string; isTest?: boolean; shopperSub: string };
const recorded = (type: string): Recorded[] =>
  recordMock.mock.calls.map(([event]) => event as Recorded).filter((event) => event.type === type);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function post(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.APP_BASE_URL = "http://localhost";
  db.meta = {};
  db.patches = [];
  recordMock.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(events, "recordBiEvent").mockImplementation(recordMock);
  getShopper.mockReset().mockResolvedValue({ id: SUB });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.APP_BASE_URL;
  delete process.env.DEMO_SHOPPER_SUB;
  vi.restoreAllMocks();
});

describe.each([
  { label: "test shopper (is_test)", meta: { is_test: true }, tagged: true },
  { label: "non-test shopper", meta: {}, tagged: false },
  { label: "is_test false", meta: { is_test: false }, tagged: false },
])("is_test tagging for $label", ({ meta, tagged }) => {
  const expected = tagged ? true : undefined;

  it("tags product.viewed", async () => {
    db.meta = structuredClone(meta);
    const res = await viewPost(post("http://localhost/api/products/view", { productId: "mug" }));
    expect(res.status).toBe(204);
    await flush();
    const [event] = recorded("product.viewed");
    expect(event?.isTest).toBe(expected);
  });

  it("tags cart.added", async () => {
    db.meta = structuredClone(meta);
    const res = await cartPost(post("http://localhost/api/cart/items", { productId: "mug" }));
    expect(res.status).toBe(200);
    await flush();
    const [event] = recorded("cart.added");
    expect(event?.isTest).toBe(expected);
  });

  it("tags order.placed and order.cancelled", async () => {
    db.meta = structuredClone(meta);
    const now = new Date("2026-11-21T10:00:00.000Z");
    await addToCart(SUB, "mug", 1, now);
    const placed = await placeOrder(SUB, now);
    expect("id" in placed).toBe(true);
    if (!("id" in placed)) return;
    await flush();
    expect(recorded("order.placed")[0]?.isTest).toBe(expected);

    const cancelled = await cancelOrder(SUB, placed.id, new Date(now.getTime() + 1000));
    expect("id" in cancelled).toBe(true);
    await flush();
    expect(recorded("order.cancelled")[0]?.isTest).toBe(expected);
  });
});

describe("is_test tagging for the configured demo shopper", () => {
  beforeEach(() => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    getShopper.mockResolvedValue({ id: DEMO_SUB });
  });

  it("tags all four events even when app_metadata has no is_test", async () => {
    const now = new Date("2026-11-21T10:00:00.000Z");
    await viewPost(post("http://localhost/api/products/view", { productId: "mug" }));
    await cartPost(post("http://localhost/api/cart/items", { productId: "mug" }));
    const placed = await placeOrder(DEMO_SUB, now);
    if (!("id" in placed)) throw new Error("order not placed");
    await cancelOrder(DEMO_SUB, placed.id, new Date(now.getTime() + 1000));
    await flush();
    for (const type of ["product.viewed", "cart.added", "order.placed", "order.cancelled"]) {
      expect(recorded(type)[0]?.isTest, type).toBe(true);
    }
  });
});

describe("POST /api/products/view rate limit", () => {
  it("takes a productViews slot from chat_limits like a cart write does", async () => {
    const res = await viewPost(post("http://localhost/api/products/view", { productId: "mug" }));
    expect(res.status).toBe(204);
    const limits = db.meta.chat_limits as { productViews?: number[] };
    expect(limits.productViews).toHaveLength(1);
    expect(Object.keys(db.patches[0] ?? {})).toEqual(["chat_limits"]);
  });

  it("answers 429 with Retry-After once the hourly allowance is used, and records nothing", async () => {
    const now = Date.now();
    db.meta = {
      chat_limits: {
        messages: [],
        cartWrites: [],
        orderWrites: [],
        productViews: Array.from({ length: PRODUCT_VIEW_HOUR_LIMIT }, (_, i) => now - 60_000 + i),
      },
    };
    const res = await viewPost(post("http://localhost/api/products/view", { productId: "mug" }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(db.patches).toEqual([]);
    await flush();
    expect(recorded("product.viewed")).toEqual([]);
  });

  it("does not count views against the cart write allowance", async () => {
    await viewPost(post("http://localhost/api/products/view", { productId: "mug" }));
    const limits = db.meta.chat_limits as { cartWrites?: number[] };
    expect(limits.cartWrites ?? []).toEqual([]);
  });

  it("uses no slot for an invalid body or an unknown product", async () => {
    expect((await viewPost(post("http://localhost/api/products/view", {}))).status).toBe(400);
    expect((await viewPost(post("http://localhost/api/products/view", { productId: "nope" }))).status).toBe(204);
    expect(db.patches).toEqual([]);
  });

  it("still needs a signed-in shopper", async () => {
    getShopper.mockResolvedValue(null);
    expect((await viewPost(post("http://localhost/api/products/view", { productId: "mug" }))).status).toBe(401);
    expect(db.patches).toEqual([]);
  });
});
