import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const neonMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const sqlMock = vi.hoisted(() => vi.fn());
const getShopper = vi.hoisted(() => vi.fn());
const addToCart = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {
    throw new Error("outside request scope");
  },
}));
vi.mock("@/lib/shopper", () => ({ getShopper }));
vi.mock("@/lib/store-meta", () => ({ addToCart, removeFromCart: vi.fn() }));
vi.mock("@/lib/store-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store-http")>()),
  requireShopper: async () => ({ userId: "auth0|abc" }),
  requireWrite: () => null,
}));

import { hashShopperId } from "@/lib/bi-hash";
import { recordBiEvent, shapeBiEvent, type BiEventInput } from "@/lib/bi-events";
import * as events from "@/lib/bi-events";
import { isTestShopper, trackCartAdded, trackProductViewed } from "@/lib/bi-track";

const SUB = "auth0|65f1c0ffee00112233445566";

function viewed(overrides: Partial<BiEventInput<"product.viewed">> = {}): BiEventInput<"product.viewed"> {
  return { type: "product.viewed", source: "live", shopperSub: SUB, payload: { productId: "mug" }, ...overrides };
}

let dbCount = 0;

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  dbCount += 1;
  process.env.DATABASE_URL = `postgres://user:pw@db${dbCount}.example/neondb`;
  neonMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BI_HASH_SECRET;
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("product.viewed and cart.added schemas", () => {
  it("accepts a valid product.viewed and hashes the shopper", () => {
    const row = shapeBiEvent(viewed());
    expect(row.eventType).toBe("product.viewed");
    expect(row.payload).toEqual({ productId: "mug" });
    expect(row.shopperHash).toBe(hashShopperId(SUB));
    expect(row.isTest).toBe(false);
  });

  it("rejects unknown fields and unsafe ids on product.viewed", () => {
    expect(() => shapeBiEvent(viewed({ payload: { productId: "mug", name: "Jane" } as never }))).toThrow();
    expect(() => shapeBiEvent(viewed({ payload: { productId: "not an id!" } }))).toThrow();
    expect(() => shapeBiEvent(viewed({ payload: {} as never }))).toThrow();
  });

  it("accepts cart.added from the ui and the barista", () => {
    for (const source of ["ui", "barista"] as const) {
      const row = shapeBiEvent({
        type: "cart.added",
        source: "live",
        shopperSub: SUB,
        payload: { productId: "mug", qty: 2, source },
      });
      expect(row.payload).toEqual({ productId: "mug", qty: 2, source });
    }
  });

  it("rejects a bad cart.added source, qty, or extra field", () => {
    const base = { type: "cart.added", source: "live", shopperSub: SUB } as const;
    expect(() => shapeBiEvent({ ...base, payload: { productId: "mug", qty: 1, source: "email" as never } })).toThrow();
    expect(() => shapeBiEvent({ ...base, payload: { productId: "mug", qty: 0, source: "ui" } })).toThrow();
    expect(() => shapeBiEvent({ ...base, payload: { productId: "mug", qty: 1.5, source: "ui" } })).toThrow();
    expect(() => shapeBiEvent({ ...base, payload: { productId: "mug", qty: 1, source: "ui", note: "x" } as never })).toThrow();
    expect(() => shapeBiEvent({ ...base, payload: { productId: "mug", qty: 1 } as never })).toThrow();
  });
});

describe("is_test tagging", () => {
  it("only a literal true counts as test traffic", () => {
    expect(isTestShopper({ is_test: true })).toBe(true);
    for (const meta of [undefined, null, {}, { is_test: false }, { is_test: "true" }, { is_test: 1 }, "x", []]) {
      expect(isTestShopper(meta)).toBe(false);
    }
  });

  it("leaves the insert unchanged for live traffic, so it works before the migration", async () => {
    const sql = vi.fn(async () => []);
    neonMock.mockReturnValue(sql);
    expect(await recordBiEvent(viewed())).toEqual({ ok: true });
    const [strings] = sql.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(strings.join("?")).not.toContain("is_test");
  });

  it("writes is_test = true for flagged traffic", async () => {
    const sql = vi.fn(async () => []);
    neonMock.mockReturnValue(sql);
    expect(await recordBiEvent(viewed({ isTest: true }))).toEqual({ ok: true });
    const [strings, ...values] = sql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("is_test");
    expect(values).not.toContain(SUB);
  });

  it("ignores a non-boolean flag", () => {
    expect(shapeBiEvent(viewed({ isTest: "yes" as never })).isTest).toBe(false);
  });
});

describe("trackers", () => {
  beforeEach(() => {
    recordMock.mockReset().mockResolvedValue({ ok: true });
    vi.spyOn(events, "recordBiEvent").mockImplementation(recordMock);
  });

  it("trackProductViewed records a live event with a safe session id", async () => {
    await trackProductViewed({ sub: SUB, sessionId: "chat_1" }, { productId: "mug" });
    expect(recordMock).toHaveBeenCalledWith({
      type: "product.viewed",
      source: "live",
      shopperSub: SUB,
      sessionId: "chat_1",
      payload: { productId: "mug" },
    });
  });

  it("trackCartAdded passes the test flag through", async () => {
    await trackCartAdded({ sub: SUB, isTest: true }, { productId: "mug", qty: 3, source: "barista" });
    expect(recordMock).toHaveBeenCalledWith({
      type: "cart.added",
      source: "live",
      shopperSub: SUB,
      sessionId: null,
      isTest: true,
      payload: { productId: "mug", qty: 3, source: "barista" },
    });
  });

  it("swallows a Neon outage through the real writer", async () => {
    vi.mocked(events.recordBiEvent).mockRestore();
    neonMock.mockReturnValue(vi.fn(async () => Promise.reject(new Error("neon down"))));
    await expect(trackProductViewed({ sub: SUB }, { productId: "mug" })).resolves.toBeUndefined();
    await expect(trackCartAdded({ sub: SUB }, { productId: "mug", qty: 1, source: "ui" })).resolves.toBeUndefined();
  });
});

describe("routes", () => {
  const sql = sqlMock;

  beforeEach(() => {
    process.env.APP_BASE_URL = "http://localhost";
    sql.mockReset().mockResolvedValue([]);
    neonMock.mockReset().mockReturnValue(sql);
    getShopper.mockReset().mockResolvedValue({ id: "auth0|abc" });
    addToCart.mockReset().mockResolvedValue({ items: [{ productId: "mug", qty: 1 }] });
  });

  const post = (url: string, body: unknown) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const insertedTypes = () =>
    sql.mock.calls.map(([, type]) => type as string);

  it("POST /api/products/view records product.viewed and returns 204", async () => {
    const { POST } = await import("@/app/api/products/view/route");
    const res = await POST(post("http://localhost/api/products/view", { productId: "mug" }));
    expect(res.status).toBe(204);
    await flush();
    expect(insertedTypes()).toEqual(["product.viewed"]);
  });

  it("POST /api/products/view stays 204 when Neon is down, and ignores unknown products", async () => {
    const { POST } = await import("@/app/api/products/view/route");
    sql.mockRejectedValue(new Error("neon down"));
    expect((await POST(post("http://localhost/api/products/view", { productId: "mug" }))).status).toBe(204);
    await flush();
    sql.mockClear();
    expect((await POST(post("http://localhost/api/products/view", { productId: "nope" }))).status).toBe(204);
    await flush();
    expect(sql).not.toHaveBeenCalled();
  });

  it("POST /api/products/view needs a signed-in shopper and a valid body", async () => {
    const { POST } = await import("@/app/api/products/view/route");
    expect((await POST(post("http://localhost/api/products/view", {}))).status).toBe(400);
    getShopper.mockResolvedValue(null);
    expect((await POST(post("http://localhost/api/products/view", { productId: "mug" }))).status).toBe(401);
  });

  it("cart add records cart.added as ui, or barista when it came from chat", async () => {
    const { POST } = await import("@/app/api/cart/items/route");
    await POST(post("http://localhost/api/cart/items", { productId: "mug", qty: 2 }));
    await flush();
    const first = sql.mock.calls.find(([, type]) => type === "cart.added");
    expect(first?.[5]).toBe(JSON.stringify({ productId: "mug", qty: 2, source: "ui" }));

    sql.mockClear();
    await POST(post("http://localhost/api/cart/items", { productId: "mug", sessionId: "chat_1" }));
    await flush();
    const second = sql.mock.calls.find(([, type]) => type === "cart.added");
    expect(second?.[5]).toBe(JSON.stringify({ productId: "mug", qty: 1, source: "barista" }));
  });

  it("cart add still succeeds when Neon is down and skips failed adds", async () => {
    const { POST } = await import("@/app/api/cart/items/route");
    sql.mockRejectedValue(new Error("neon down"));
    expect((await POST(post("http://localhost/api/cart/items", { productId: "mug" }))).status).toBe(200);
    await flush();
    sql.mockClear().mockResolvedValue([]);
    addToCart.mockResolvedValue({ error: "qty_limit" });
    expect((await POST(post("http://localhost/api/cart/items", { productId: "mug" }))).status).toBe(400);
    await flush();
    expect(sql).not.toHaveBeenCalled();
  });
});
