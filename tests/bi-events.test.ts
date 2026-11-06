import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

import { BiHashConfigError, hashShopperId } from "@/lib/bi-hash";
import {
  BI_EVENT_TYPES,
  isBiEventType,
  recordBiEvent,
  shapeBiEvent,
  type BiEventInput,
} from "@/lib/bi-events";

const SECRET = "test-bi-hash-secret-0123456789";
const SUB = "auth0|65f1c0ffee00112233445566";

function turn(overrides: Partial<BiEventInput<"barista.turn">> = {}): BiEventInput<"barista.turn"> {
  return {
    type: "barista.turn",
    source: "live",
    shopperSub: SUB,
    sessionId: "chat_abc-123",
    payload: { outcome: "replied", userMessageChars: 42, toolIds: ["search_products"], latencyMs: 900 },
    ...overrides,
  };
}

let dbUrl = "";
let dbCount = 0;

beforeEach(() => {
  process.env.BI_HASH_SECRET = SECRET;
  dbCount += 1;
  dbUrl = `postgres://user:pw@db${dbCount}.example/neondb`;
  process.env.DATABASE_URL = dbUrl;
  neonMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BI_HASH_SECRET;
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("hashShopperId", () => {
  it("is a stable 64-char hex HMAC that does not contain the sub", () => {
    const hash = hashShopperId(SUB);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashShopperId(SUB)).toBe(hash);
    expect(hashShopperId(`  ${SUB} `)).toBe(hash);
    expect(hash).not.toContain("65f1c0ffee");
    expect(hashShopperId("auth0|other")).not.toBe(hash);
  });

  it("changes with the secret, so it is not a plain hash of the sub", () => {
    const first = hashShopperId(SUB);
    process.env.BI_HASH_SECRET = "a-different-secret-0123456789";
    expect(hashShopperId(SUB)).not.toBe(first);
  });

  it("refuses to hash without a usable secret or sub", () => {
    delete process.env.BI_HASH_SECRET;
    expect(() => hashShopperId(SUB)).toThrow(BiHashConfigError);
    process.env.BI_HASH_SECRET = "short";
    expect(() => hashShopperId(SUB)).toThrow(BiHashConfigError);
    process.env.BI_HASH_SECRET = SECRET;
    expect(() => hashShopperId("  ")).toThrow();
  });
});

describe("event types and payload shaping", () => {
  it("knows the MVP event kinds", () => {
    expect([...BI_EVENT_TYPES].sort()).toEqual(
      [
        "barista.turn",
        "recommend.added",
        "recommend.shown",
        "recommend.undone",
        "order.cancelled",
        "order.placed",
      ].sort(),
    );
    expect(isBiEventType("barista.turn")).toBe(true);
    expect(isBiEventType("barista.chat")).toBe(false);
    expect(isBiEventType("toString")).toBe(false);
    expect(isBiEventType(7)).toBe(false);
  });

  it("shapes a row with a hashed shopper and no raw sub", () => {
    const row = shapeBiEvent(turn());
    expect(row.shopperHash).toBe(hashShopperId(SUB));
    expect(row.sessionId).toBe("chat_abc-123");
    expect(row.source).toBe("live");
    expect(JSON.stringify(row)).not.toContain(SUB);
  });

  it("accepts a null or missing session id", () => {
    expect(shapeBiEvent(turn({ sessionId: null })).sessionId).toBeNull();
    expect(shapeBiEvent(turn({ sessionId: undefined })).sessionId).toBeNull();
  });

  it("rejects unknown fields so chat text or PII cannot ride along", () => {
    const payload = { ...turn().payload, text: "I want a dark roast, my email is a@b.co" };
    expect(() => shapeBiEvent(turn({ payload: payload as never }))).toThrow();
  });

  it("rejects free text where an id is expected", () => {
    const payload = { ...turn().payload, toolIds: ["tell me about my order for jane@example.com"] };
    expect(() => shapeBiEvent(turn({ payload }))).toThrow();
  });

  it("rejects unknown types, sources, and malformed session ids", () => {
    expect(() => shapeBiEvent({ ...turn(), type: "barista.chat" as never })).toThrow();
    expect(() => shapeBiEvent({ ...turn(), source: "admin" as never })).toThrow();
    expect(() => shapeBiEvent(turn({ sessionId: "has spaces and text" }))).toThrow();
    expect(() => shapeBiEvent(turn({ sessionId: "x".repeat(65) }))).toThrow();
  });

  it("validates the order, recommend, and cancel payloads", () => {
    const placed = shapeBiEvent({
      type: "order.placed",
      source: "demo",
      shopperSub: SUB,
      payload: {
        orderId: "ord_1",
        subtotalCents: 3000,
        discountCents: 300,
        taxCents: 216,
        totalCents: 2916,
        coupon: "SAVE10",
        items: [{ productId: "house-espresso", qty: 2, unitPriceCents: 1500 }],
      },
    });
    expect(placed.source).toBe("demo");
    expect(() =>
      shapeBiEvent({
        type: "order.placed",
        source: "live",
        shopperSub: SUB,
        payload: { orderId: "ord_1", subtotalCents: -1, discountCents: 0, taxCents: 0, totalCents: 0, coupon: null, items: [] },
      }),
    ).toThrow();
    expect(
      shapeBiEvent({ type: "order.cancelled", source: "live", shopperSub: SUB, payload: { orderId: "ord_1", totalCents: 2916 } })
        .eventType,
    ).toBe("order.cancelled");
    expect(
      shapeBiEvent({
        type: "recommend.shown",
        source: "live",
        shopperSub: SUB,
        payload: { recommendationId: "rec_1", productIds: ["a", "b"], surface: "chat" },
      }).payload,
    ).toEqual({ recommendationId: "rec_1", productIds: ["a", "b"], surface: "chat" });
    expect(() =>
      shapeBiEvent({
        type: "recommend.added",
        source: "live",
        shopperSub: SUB,
        payload: { recommendationId: "rec_1", productId: "a", qty: 0 },
      }),
    ).toThrow();
    expect(
      shapeBiEvent({
        type: "recommend.undone",
        source: "live",
        shopperSub: SUB,
        payload: { recommendationId: "rec_1", productId: "a" },
      }).eventType,
    ).toBe("recommend.undone");
  });
});

describe("recordBiEvent", () => {
  it("inserts a hashed, shaped row through the Neon client", async () => {
    const sql = vi.fn(async () => []);
    neonMock.mockReturnValue(sql);
    expect(await recordBiEvent(turn())).toEqual({ ok: true });
    expect(neonMock).toHaveBeenCalledWith(dbUrl);
    const [strings, ...values] = sql.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("INSERT INTO bi_events");
    expect(values).toEqual([
      "barista.turn",
      "live",
      hashShopperId(SUB),
      "chat_abc-123",
      JSON.stringify(turn().payload),
    ]);
    expect(values).not.toContain(SUB);
  });

  it("is a no-op without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    expect(await recordBiEvent(turn())).toEqual({ ok: false, reason: "unconfigured" });
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("skips writing when BI_HASH_SECRET is unset instead of storing an unhashed id", async () => {
    delete process.env.BI_HASH_SECRET;
    const sql = vi.fn(async () => []);
    neonMock.mockReturnValue(sql);
    expect(await recordBiEvent(turn())).toEqual({ ok: false, reason: "unconfigured" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("does not insert an invalid event and does not throw", async () => {
    const sql = vi.fn(async () => []);
    neonMock.mockReturnValue(sql);
    const bad = turn({ payload: { ...turn().payload, text: "hello" } as never });
    expect(await recordBiEvent(bad)).toEqual({ ok: false, reason: "invalid" });
    expect(sql).not.toHaveBeenCalled();
  });

  it("swallows database failures without logging the payload or URL", async () => {
    neonMock.mockReturnValue(
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED postgres://user:pw@db.example/neondb");
      }),
    );
    expect(await recordBiEvent(turn())).toEqual({ ok: false, reason: "error" });
    const logged = JSON.stringify((console.error as unknown as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("pw@");
    expect(logged).not.toContain(SUB);
  });

  it("gives up on a hung database instead of blocking the shopper", async () => {
    vi.useFakeTimers();
    neonMock.mockReturnValue(vi.fn(() => new Promise(() => undefined)));
    const pending = recordBiEvent(turn());
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toEqual({ ok: false, reason: "error" });
  });
});
