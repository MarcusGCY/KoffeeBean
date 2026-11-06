import { beforeEach, describe, expect, it, vi } from "vitest";

const recordMock = vi.hoisted(() => vi.fn());
const redisMock = vi.hoisted(() => vi.fn());
const adminMock = vi.hoisted(() => vi.fn());
const sqlMock = vi.hoisted(() => vi.fn());
const afterMock = vi.hoisted(() => vi.fn());

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: recordMock,
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => true, getBiSql: () => sqlMock }));
vi.mock("@/lib/demo-session", () => ({ readAdmin: adminMock }));
vi.mock("@/lib/upstash", () => ({ redisPipeline: redisMock }));

import {
  ATTRIBUTION_TTL_SEC,
  biSessionId,
  biSource,
  emitBi,
  startTurn,
  takeAttributedSkus,
  trackAdded,
  trackOrderCancelled,
  trackOrderPlaced,
  trackShown,
  trackTurn,
  trackUndone,
  type PlacedOrder,
} from "@/lib/bi-track";

const SUB = "auth0|65f1c0ffee00112233445566";
const TOOLS = ["search_products", "get_cart"];

const order: PlacedOrder = {
  id: "BB-ABC234",
  createdAt: "2026-11-06T15:00:00.000Z",
  subtotalCents: 3000,
  discountCents: 0,
  taxCents: 270,
  totalCents: 3270,
  coupon: null,
  items: [
    { productId: "ethiopia-250", qty: 1, unitPriceCents: 1800 },
    { productId: "mug", qty: 1, unitPriceCents: 1200 },
  ],
};

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  recordMock.mockReset().mockResolvedValue({ ok: true });
  redisMock.mockReset().mockResolvedValue(["OK"]);
  adminMock.mockReset().mockResolvedValue(null);
  sqlMock.mockReset().mockResolvedValue([]);
  afterMock.mockReset().mockImplementation(() => {
    throw new Error("outside request scope");
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("biSource", () => {
  it("tags admin sessions as demo and everyone else as live", async () => {
    adminMock.mockResolvedValueOnce({ id: SUB, email: "admin@example.com" });
    expect(await biSource()).toBe("demo");
    adminMock.mockResolvedValueOnce(null);
    expect(await biSource()).toBe("live");
  });

  it("falls back to live when the session cannot be read", async () => {
    adminMock.mockRejectedValueOnce(new Error("no request"));
    expect(await biSource()).toBe("live");
  });
});

describe("biSessionId", () => {
  it("keeps BI-safe ids and drops anything else", () => {
    expect(biSessionId("chat_1234-abcd")).toBe("chat_1234-abcd");
    expect(biSessionId("has spaces")).toBeNull();
    expect(biSessionId("x".repeat(65))).toBeNull();
    expect(biSessionId(undefined)).toBeNull();
  });
});

describe("event helpers", () => {
  it("passes the raw sub, resolved source, and a sanitized session id to recordBiEvent", async () => {
    adminMock.mockResolvedValue({ id: SUB, email: "admin@example.com" });
    await trackTurn(
      { sub: SUB, sessionId: "bad session!" },
      { outcome: "replied", userMessageChars: 12, toolIds: ["search_products"], latencyMs: 40 },
    );
    expect(recordMock).toHaveBeenCalledWith({
      type: "barista.turn",
      source: "demo",
      shopperSub: SUB,
      sessionId: null,
      payload: { outcome: "replied", userMessageChars: 12, toolIds: ["search_products"], latencyMs: 40 },
    });
  });

  it("uses an explicit source without reading the session", async () => {
    await trackShown({ sub: SUB, source: "live" }, { recommendationId: "rec_1", productIds: ["mug"] });
    expect(adminMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "recommend.shown",
        source: "live",
        payload: { recommendationId: "rec_1", productIds: ["mug"], surface: "chat" },
      }),
    );
  });

  it("marks the SKU for attribution on add and clears it on undo", async () => {
    await trackAdded({ sub: SUB, source: "live" }, { recommendationId: "rec_1", productId: "mug", qty: 1 });
    expect(redisMock).toHaveBeenCalledWith([["SET", `kb:bi:rec:${SUB}:mug`, "1", "EX", ATTRIBUTION_TTL_SEC]]);
    expect(recordMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "recommend.added" }));

    await trackUndone({ sub: SUB, source: "live" }, { recommendationId: "rec_1", productId: "mug" });
    expect(redisMock).toHaveBeenLastCalledWith([["DEL", `kb:bi:rec:${SUB}:mug`]]);
    expect(recordMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "recommend.undone", payload: { recommendationId: "rec_1", productId: "mug" } }),
    );
  });

  it("still records the event when Redis attribution fails", async () => {
    redisMock.mockRejectedValue(new Error("redis down"));
    await trackAdded({ sub: SUB, source: "live" }, { recommendationId: "rec_1", productId: "mug", qty: 1 });
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ type: "recommend.added" }));
  });
});

describe("startTurn", () => {
  it("emits one recommend.shown and one barista.turn with ids and lengths only", async () => {
    let clock = 1000;
    const turn = startTurn({ sub: SUB, source: "live", sessionId: "chat_abc" }, 25, TOOLS, () => clock);
    turn.tool("search_products");
    turn.tool("search_products");
    turn.tool("not_a_real_tool");
    const first = turn.shownProducts(["ethiopia-250", "mug"]);
    const second = turn.shownProducts(["mug", "tote"]);
    expect(second).toBe(first);
    expect(first).toMatch(/^rec_[0-9a-f]{12}$/);
    clock = 1450;
    turn.finish("replied");
    turn.finish("error");
    await flush();

    expect(recordMock).toHaveBeenCalledTimes(2);
    expect(recordMock).toHaveBeenNthCalledWith(1, {
      type: "recommend.shown",
      source: "live",
      shopperSub: SUB,
      sessionId: "chat_abc",
      payload: { recommendationId: first, productIds: ["ethiopia-250", "mug", "tote"], surface: "chat" },
    });
    expect(recordMock).toHaveBeenNthCalledWith(2, {
      type: "barista.turn",
      source: "live",
      shopperSub: SUB,
      sessionId: "chat_abc",
      payload: { outcome: "replied", userMessageChars: 25, toolIds: ["search_products"], latencyMs: 450 },
    });
  });

  it("skips recommend.shown when no cards were shown", async () => {
    const turn = startTurn({ sub: SUB, source: "demo" }, 5, TOOLS);
    turn.finish("timeout");
    await flush();
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "barista.turn",
        source: "demo",
        payload: expect.objectContaining({ outcome: "timeout", toolIds: [] }),
      }),
    );
  });

  it("does not throw when recordBiEvent rejects", async () => {
    recordMock.mockRejectedValue(new Error("neon down"));
    const turn = startTurn({ sub: SUB, source: "live" }, 5, TOOLS);
    expect(() => turn.finish("error")).not.toThrow();
    await flush();
  });
});

describe("emitBi", () => {
  it("defers to after() when a request scope exists", async () => {
    afterMock.mockImplementation(() => undefined);
    const task = vi.fn().mockResolvedValue(undefined);
    emitBi(task);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();
    await afterMock.mock.calls[0]?.[0]();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing task", async () => {
    const task = vi.fn().mockRejectedValue(new Error("boom"));
    expect(() => emitBi(task)).not.toThrow();
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe("takeAttributedSkus", () => {
  it("returns the marked SKUs and consumes them", async () => {
    redisMock.mockResolvedValueOnce([["1", null]]).mockResolvedValueOnce([1]);
    const hits = await takeAttributedSkus(SUB, ["ethiopia-250", "mug"]);
    expect(hits).toEqual(["ethiopia-250"]);
    expect(redisMock).toHaveBeenNthCalledWith(1, [["MGET", `kb:bi:rec:${SUB}:ethiopia-250`, `kb:bi:rec:${SUB}:mug`]]);
    expect(redisMock).toHaveBeenNthCalledWith(2, [["DEL", `kb:bi:rec:${SUB}:ethiopia-250`]]);
  });

  it("is empty when Redis is unavailable", async () => {
    redisMock.mockRejectedValue(new Error("down"));
    expect(await takeAttributedSkus(SUB, ["mug"])).toEqual([]);
  });
});

describe("orders", () => {
  it("records order.placed and upserts bi_orders with attributed SKUs", async () => {
    redisMock.mockResolvedValueOnce([[null, "1"]]).mockResolvedValueOnce([1]);
    await trackOrderPlaced({ sub: SUB, source: "live" }, order);

    expect(recordMock).toHaveBeenCalledWith({
      type: "order.placed",
      source: "live",
      shopperSub: SUB,
      sessionId: undefined,
      payload: {
        orderId: "BB-ABC234",
        subtotalCents: 3000,
        discountCents: 0,
        taxCents: 270,
        totalCents: 3270,
        coupon: null,
        items: order.items,
      },
    });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("INSERT INTO bi_orders");
    expect(strings.join("?")).toContain("ON CONFLICT (order_id) DO UPDATE");
    expect(values).toContain("BB-ABC234");
    expect(values).toContain("2026-11-06T15:00:00.000Z");
    expect(values).toContainEqual(["mug"]);
    expect(values).not.toContain(SUB);
  });

  it("does not throw when the bi_orders write fails", async () => {
    sqlMock.mockRejectedValue(new Error("neon down"));
    await expect(trackOrderPlaced({ sub: SUB, source: "live" }, order)).resolves.toBeUndefined();
  });

  it("records order.cancelled and stamps bi_orders.cancelled_at for this shopper", async () => {
    await trackOrderCancelled(
      { sub: SUB, source: "demo" },
      { id: "BB-ABC234", totalCents: 3270, cancelledAt: "2026-11-06T15:10:00.000Z" },
    );
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.cancelled",
        source: "demo",
        payload: { orderId: "BB-ABC234", totalCents: 3270 },
      }),
    );
    const [strings, ...values] = sqlMock.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("UPDATE bi_orders SET cancelled_at");
    expect(values[0]).toBe("2026-11-06T15:10:00.000Z");
    expect(values[1]).toBe("BB-ABC234");
    expect(values).not.toContain(SUB);
  });
});
