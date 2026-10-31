import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canCancel, orderStatus } from "@/lib/order-status";
import { getShopper } from "@/lib/shopper";
import { addToCart, cancelOrder, getCart, getOrder, placeOrder } from "@/lib/store-db";
import { GET as getCartRoute } from "@/app/api/cart/route";
import { POST as addItemRoute } from "@/app/api/cart/items/route";
import { POST as placeOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";

vi.mock("@/lib/shopper", () => ({
  getShopper: vi.fn(),
}));

vi.mock("@/lib/store-db", () => ({
  getCart: vi.fn(),
  addToCart: vi.fn(),
  removeFromCart: vi.fn(),
  applyCoupon: vi.fn(),
  clearCoupon: vi.fn(),
  placeOrder: vi.fn(),
  listOrders: vi.fn(),
  getOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));

const saved = {
  DATABASE_URL: process.env.DATABASE_URL,
  APP_BASE_URL: process.env.APP_BASE_URL,
};

function signIn(id = "auth0|shopper") {
  vi.mocked(getShopper).mockResolvedValue({ id, email: "shopper@example.com", name: "Shopper" });
}

function write(path: string, body: unknown) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

describe("order status", () => {
  const created = new Date("2026-10-31T00:00:00.000Z");
  const at = (ms: number) => new Date(created.getTime() + ms);

  it("moves from placed to delivered by elapsed time, and cancelled wins", () => {
    expect(orderStatus(created, null, at(0))).toBe("placed");
    expect(orderStatus(created, null, at(2 * 60 * 1000 - 1))).toBe("placed");
    expect(orderStatus(created, null, at(2 * 60 * 1000))).toBe("packed");
    expect(orderStatus(created, null, at(10 * 60 * 1000 - 1))).toBe("packed");
    expect(orderStatus(created, null, at(10 * 60 * 1000))).toBe("shipped");
    expect(orderStatus(created, null, at(30 * 60 * 1000 - 1))).toBe("shipped");
    expect(orderStatus(created, null, at(30 * 60 * 1000))).toBe("delivered");
    expect(orderStatus(created, at(1_000), at(60 * 60 * 1000))).toBe("cancelled");
    expect(canCancel("placed")).toBe(true);
    expect(canCancel("packed")).toBe(true);
    expect(canCancel("shipped")).toBe(false);
    expect(canCancel("delivered")).toBe(false);
    expect(canCancel("cancelled")).toBe(false);
  });
});

describe("store API", () => {
  beforeEach(() => {
    saved.DATABASE_URL = process.env.DATABASE_URL;
    saved.APP_BASE_URL = process.env.APP_BASE_URL;
    process.env.DATABASE_URL = "postgres://unit-test";
    process.env.APP_BASE_URL = "http://localhost:3000";
    vi.mocked(getShopper).mockReset();
    vi.mocked(getCart).mockReset();
    vi.mocked(addToCart).mockReset();
    vi.mocked(placeOrder).mockReset();
    vi.mocked(getOrder).mockReset();
    vi.mocked(cancelOrder).mockReset();
  });

  afterEach(() => {
    if (saved.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.DATABASE_URL;
    if (saved.APP_BASE_URL === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = saved.APP_BASE_URL;
  });

  it("returns 401 when the shopper is signed out", async () => {
    vi.mocked(getShopper).mockResolvedValue(null);
    const res = await getCartRoute();
    expect(res.status).toBe(401);
    expect(vi.mocked(getCart)).not.toHaveBeenCalled();

    const checkout = await placeOrderRoute(write("/api/orders", { userId: "auth0|other" }));
    expect(checkout.status).toBe(401);
    expect(vi.mocked(placeOrder)).not.toHaveBeenCalled();
  });

  it("ignores a userId in the body and uses the signed-in shopper", async () => {
    signIn("auth0|shopper");
    vi.mocked(addToCart).mockResolvedValue({
      items: [{ productId: "mug", qty: 2 }],
      coupon: null,
      subtotalCents: 2800,
      discountCents: 0,
      taxCents: 224,
      totalCents: 3024,
    });
    const res = await addItemRoute(write("/api/cart/items", { productId: "mug", qty: 2, userId: "auth0|other" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(addToCart)).toHaveBeenCalledWith("auth0|shopper", "mug", 2);
  });

  it("rejects checkout of an empty cart", async () => {
    signIn();
    vi.mocked(placeOrder).mockResolvedValue({ error: "empty_cart" });
    const res = await placeOrderRoute(write("/api/orders", {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_cart" });
    expect(vi.mocked(placeOrder)).toHaveBeenCalledWith("auth0|shopper");
  });

  it("returns the same 404 for a missing order and another shopper's order", async () => {
    signIn("auth0|shopper");
    vi.mocked(getOrder).mockResolvedValue(null);
    const missing = await getOrderRoute(new Request("http://localhost:3000/api/orders/BB-MISSING"), {
      params: Promise.resolve({ id: "BB-MISSING" }),
    });
    const other = await getOrderRoute(new Request("http://localhost:3000/api/orders/BB-OTHER1"), {
      params: Promise.resolve({ id: "BB-OTHER1" }),
    });
    expect(missing.status).toBe(404);
    expect(other.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(await other.json()).toEqual({ error: "not_found" });
    expect(vi.mocked(getOrder)).toHaveBeenNthCalledWith(1, "auth0|shopper", "BB-MISSING");
    expect(vi.mocked(getOrder)).toHaveBeenNthCalledWith(2, "auth0|shopper", "BB-OTHER1");
  });

  it("cancels while packed and returns 409 once shipped", async () => {
    const created = new Date("2026-10-31T00:00:00.000Z");
    expect(canCancel(orderStatus(created, null, new Date(created.getTime() + 9 * 60 * 1000)))).toBe(true);
    expect(canCancel(orderStatus(created, null, new Date(created.getTime() + 10 * 60 * 1000)))).toBe(false);

    signIn();
    vi.mocked(cancelOrder).mockResolvedValueOnce({
      id: "BB-PACKED",
      createdAt: created.toISOString(),
      status: "cancelled",
      cancellable: false,
      totalCents: 1400,
      subtotalCents: 1400,
      discountCents: 0,
      taxCents: 112,
      coupon: null,
    });
    const packed = await cancelRoute(write("/api/orders/BB-PACKED/cancel", { userId: "auth0|other" }), {
      params: Promise.resolve({ id: "BB-PACKED" }),
    });
    expect(packed.status).toBe(200);
    expect(vi.mocked(cancelOrder)).toHaveBeenCalledWith("auth0|shopper", "BB-PACKED");

    vi.mocked(cancelOrder).mockResolvedValueOnce({ error: "not_cancellable" });
    const shipped = await cancelRoute(write("/api/orders/BB-SHIPPD/cancel", {}), {
      params: Promise.resolve({ id: "BB-SHIPPD" }),
    });
    expect(shipped.status).toBe(409);
    expect(await shipped.json()).toEqual({ error: "not_cancellable" });
  });
});
