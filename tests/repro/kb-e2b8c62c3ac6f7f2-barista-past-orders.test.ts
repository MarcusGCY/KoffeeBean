import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChatTool } from "@/lib/chat-tools";
import { listOrders } from "@/lib/store-meta";

const db = vi.hoisted(() => ({
  meta: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async (userId: string) => structuredClone(db.meta.get(userId) ?? {}),
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    const next = { ...(db.meta.get(userId) ?? {}), ...patch };
    db.meta.set(userId, next);
    return structuredClone(next);
  },
}));

vi.mock("@/lib/pending-action", () => ({
  proposeAction: vi.fn(async () => ({ pending: true, actionId: "signed", summary: "Add 1 mug" })),
  confirmedCard: vi.fn(() => undefined),
}));

function storedOrder(id: string, productId: string) {
  return {
    id,
    createdAt: "2026-10-01T00:00:00.000Z",
    cancelledAt: null,
    subtotalCents: 1800,
    discountCents: 0,
    taxCents: 144,
    totalCents: 1944,
    coupon: null,
    items: [{ productId, name: "Stored line", unitPriceCents: 1800, qty: 1 }],
  };
}

function sink() {
  return { status: vi.fn(), products: vi.fn(), confirm: vi.fn(), order: vi.fn() };
}

describe("Barista past orders", () => {
  beforeEach(() => {
    db.meta.clear();
  });

  it("lists the same order count from listOrders as My orders uses", async () => {
    db.meta.set("auth0|shopper", {
      orders: [storedOrder("BB-ONE", "ethiopia-250"), storedOrder("BB-TWO", "mug")],
    });
    const orders = await listOrders("auth0|shopper");
    expect(orders.map((order) => order.id)).toEqual(["BB-ONE", "BB-TWO"]);
  });

  it("returns past orders from get_order when My orders lists them", async () => {
    db.meta.set("auth0|shopper", { orders: [storedOrder("BB-ONLY", "ethiopia-250")] });
    const chatSink = sink();
    const ran = await runChatTool("auth0|shopper", "get_order", {}, chatSink);
    expect(ran.failed).toBe(false);
    expect(JSON.parse(ran.content)).toMatchObject({ id: "BB-ONLY", items: [{ name: "Stored line", qty: 1 }] });
    expect(chatSink.order).toHaveBeenCalled();
  });

  it("lists every stored checkout when the shopper asks Barista about past orders", async () => {
    db.meta.set("auth0|shopper", {
      orders: [storedOrder("BB-NEW", "ethiopia-250"), storedOrder("BB-OLD", "mug")],
    });
    const chatSink = sink();
    const ran = await runChatTool("auth0|shopper", "get_order", {}, chatSink);
    expect(ran.failed).toBe(false);
    const body = JSON.parse(ran.content) as { orders?: { id: string }[] };
    expect(body.orders?.map((order) => order.id)).toEqual(["BB-NEW", "BB-OLD"]);
  });
});
