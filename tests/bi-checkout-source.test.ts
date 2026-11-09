import { beforeEach, describe, expect, it, vi } from "vitest";

const recordMock = vi.hoisted(() => vi.fn());
const adminMock = vi.hoisted(() => vi.fn());
const sqlMock = vi.hoisted(() => vi.fn());
const redisMock = vi.hoisted(() => vi.fn());
const afterMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: recordMock,
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => true, getBiSql: () => sqlMock }));
vi.mock("@/lib/demo-session", () => ({ readAdmin: adminMock }));
vi.mock("@/lib/upstash", () => ({ redisPipeline: redisMock }));
vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

import { trackAdded } from "@/lib/bi-track";
import { addToCart, applyCoupon, cancelOrder, placeOrder } from "@/lib/store-meta";

const SUB = "auth0|65f1c0ffee00112233445566";
const NOW = new Date("2026-11-09T08:46:13.930Z");

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  db.meta = {};
  recordMock.mockReset().mockResolvedValue({ ok: true });
  redisMock.mockReset().mockResolvedValue(["OK"]);
  sqlMock.mockReset().mockResolvedValue([]);
  adminMock.mockReset().mockResolvedValue({ id: SUB, email: "owner@example.com" });
  afterMock.mockReset().mockImplementation(() => {
    throw new Error("outside request scope");
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

async function settle() {
  await vi.waitFor(() => {
    expect(recordMock.mock.calls.length).toBeGreaterThan(0);
  });
}

describe("production checkout source", () => {
  it("records a normal checkout, its coupon, the cancellation, and recommend.added as live", async () => {
    await addToCart(SUB, "ethiopia-250", 1, NOW);
    const cart = await applyCoupon(SUB, "save10", NOW);
    expect(cart).toMatchObject({ coupon: "SAVE10" });

    await trackAdded({ sub: SUB }, { recommendationId: "rec_601e60a87cf9", productId: "ethiopia-250", qty: 1 });

    const placed = await placeOrder(SUB, NOW);
    if (!("id" in placed)) throw new Error("checkout failed");
    expect(placed.id).toMatch(/^BB-/);
    await settle();

    const cancelled = await cancelOrder(SUB, placed.id, NOW);
    if (!("id" in cancelled)) throw new Error("cancel failed");
    await vi.waitFor(() => {
      expect(recordMock.mock.calls.map((call) => call[0].type)).toContain("order.cancelled");
    });

    const events = recordMock.mock.calls.map((call) => call[0] as { type: string; source: string; payload: Record<string, unknown> });
    expect(events.map((event) => event.source)).toEqual(["live", "live", "live"]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "recommend.added",
        source: "live",
        payload: { recommendationId: "rec_601e60a87cf9", productId: "ethiopia-250", qty: 1 },
      }),
      expect.objectContaining({
        type: "order.placed",
        source: "live",
        payload: expect.objectContaining({ orderId: placed.id, coupon: "SAVE10" }),
      }),
      expect.objectContaining({
        type: "order.cancelled",
        source: "live",
        payload: expect.objectContaining({ orderId: placed.id }),
      }),
    ]);

    const orderWrite = sqlMock.mock.calls.find((call) => String(call[0]).includes("INSERT INTO bi_orders"));
    expect(orderWrite?.slice(1)).toContain("live");
    expect(orderWrite?.slice(1)).not.toContain("demo");
  });
});
