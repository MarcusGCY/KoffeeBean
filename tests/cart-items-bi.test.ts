import { beforeEach, describe, expect, it, vi } from "vitest";

const trackAdded = vi.hoisted(() => vi.fn());
const trackUndone = vi.hoisted(() => vi.fn());
const addToCart = vi.hoisted(() => vi.fn());
const removeFromCart = vi.hoisted(() => vi.fn());

vi.mock("@/lib/store-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store-http")>()),
  requireShopper: async () => ({ userId: "auth0|abc" }),
  requireWrite: () => null,
}));
vi.mock("@/lib/store-meta", () => ({ addToCart, removeFromCart }));
vi.mock("@/lib/bi-track", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-track")>()),
  emitBi: (task: () => Promise<unknown>) => void task().catch(() => undefined),
  trackAdded,
  trackUndone,
}));

import { DELETE, POST } from "@/app/api/cart/items/route";

function call(handler: typeof POST, body: unknown) {
  return handler(
    new Request("http://localhost/api/cart/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  trackAdded.mockReset().mockResolvedValue(undefined);
  trackUndone.mockReset().mockResolvedValue(undefined);
  addToCart.mockReset().mockResolvedValue({ items: [{ productId: "mug", qty: 1 }] });
  removeFromCart.mockReset().mockResolvedValue({ items: [] });
});

describe("cart items BI events", () => {
  it("emits recommend.added only when the chat card sent a recommendation id", async () => {
    await call(POST, { productId: "mug", recommendationId: "rec_abc123" });
    expect(trackAdded).toHaveBeenCalledWith(
      { sub: "auth0|abc" },
      { recommendationId: "rec_abc123", productId: "mug", qty: 1 },
    );

    await call(POST, { productId: "mug" });
    expect(trackAdded).toHaveBeenCalledTimes(1);
  });

  it("passes a validated chat session through to add and undo", async () => {
    await call(POST, { productId: "mug", recommendationId: "rec_abc123", sessionId: "chat_abc-1" });
    expect(trackAdded).toHaveBeenCalledWith(
      { sub: "auth0|abc", sessionId: "chat_abc-1" },
      { recommendationId: "rec_abc123", productId: "mug", qty: 1 },
    );

    await call(DELETE, { productId: "mug", recommendationId: "rec_abc123", sessionId: "bad session" });
    expect(trackUndone).toHaveBeenCalledWith({ sub: "auth0|abc" }, { recommendationId: "rec_abc123", productId: "mug" });
  });

  it("emits recommend.undone on DELETE with a recommendation id", async () => {
    await call(DELETE, { productId: "mug", recommendationId: "rec_abc123" });
    expect(trackUndone).toHaveBeenCalledWith({ sub: "auth0|abc" }, { recommendationId: "rec_abc123", productId: "mug" });
  });

  it("ignores unsafe ids and failed cart writes", async () => {
    await call(POST, { productId: "mug", recommendationId: "bad id!" });
    expect(trackAdded).not.toHaveBeenCalled();

    addToCart.mockResolvedValue({ error: "qty_limit" });
    const res = await call(POST, { productId: "mug", recommendationId: "rec_abc123" });
    expect(res.status).toBe(400);
    expect(trackAdded).not.toHaveBeenCalled();
  });

  it("does not break the cart when BI throws", async () => {
    trackAdded.mockRejectedValue(new Error("neon down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await call(POST, { productId: "mug", recommendationId: "rec_abc123" });
    expect(res.status).toBe(200);
  });
});
