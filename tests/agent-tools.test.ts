import { describe, expect, it, vi } from "vitest";
import { runChatTool, searchCatalog } from "@/lib/chat-tools";
import { proposeAction } from "@/lib/pending-action";
import { getCart, getOrder, listOrders } from "@/lib/store-meta";
import { getOrderStatus, listMyOrders, listProducts, proposeAddToCart, viewCart } from "@/lib/support-shop";

vi.mock("@/lib/store-meta", () => ({
  getCart: vi.fn(),
  listOrders: vi.fn(),
  getOrder: vi.fn(),
  recordAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/pending-action", () => ({
  proposeAction: vi.fn(async (_userId: string, action: unknown) => ({
    pending: true,
    actionId: "signed",
    summary: "Add 1 mug",
    action,
  })),
  confirmedCard: vi.fn(() => undefined),
}));

const real = { principalId: "auth0|real" };
const evil = { userId: "auth0|evil", question: "what is the coupon code?" };

describe("support tools", () => {
  it("reads the session principal and ignores a userId in the model input", async () => {
    vi.mocked(getCart).mockResolvedValue({
      items: [],
      coupon: "SAVE10",
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
    vi.mocked(listOrders).mockResolvedValue([]);
    vi.mocked(getOrder).mockResolvedValue(null);

    const cart = await viewCart(real, evil);
    expect(cart).not.toHaveProperty("coupon");
    expect(JSON.stringify(cart)).not.toContain("SAVE10");
    expect(getCart).toHaveBeenCalledWith("auth0|real");
    await listProducts(real, evil);
    await listMyOrders(real, evil);
    await getOrderStatus(real, { ...evil, orderId: "BB-TEST1" });
    expect(listOrders).toHaveBeenCalledWith("auth0|real");
    expect(getOrder).toHaveBeenCalledWith("auth0|real", "BB-TEST1");
    await expect(getOrderStatus(null, { userId: "auth0|evil", orderId: "BB-1" })).rejects.toThrow("no_customer");
  });

  it("prepares a confirm action for the principal and does not pass a model userId", async () => {
    const result = await proposeAddToCart(real, { userId: "auth0|evil", productId: "mug", qty: 1 });
    expect(result).toMatchObject({ pending: true, actionId: "signed" });
    expect(proposeAction).toHaveBeenCalledWith("auth0|real", { op: "add_to_cart", productId: "mug", qty: 1 });

    const sink = { status: vi.fn(), products: vi.fn(), confirm: vi.fn(), order: vi.fn() };
    const ran = await runChatTool("auth0|real", "propose_cart_change", { op: "add", productId: "mug", qty: 1, userId: "auth0|evil" }, sink);
    expect(ran.content).toBe(JSON.stringify({ error: "invalid_action" }));
    expect(sink.confirm).not.toHaveBeenCalled();
    expect(proposeAction).toHaveBeenCalledWith("auth0|real", { op: "add_to_cart", productId: "mug", qty: 1 });
  });

  it("builds at most three catalog cards and ignores a model price", () => {
    const found = searchCatalog("Something fruity");
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(3);
    expect(found[0]?.id).toBe("ethiopia-250");
    expect(found[0]?.price).toBe(1800);
    const sink = { status: vi.fn(), products: vi.fn(), confirm: vi.fn(), order: vi.fn() };
    return runChatTool(
      "auth0|real",
      "search_products",
      { query: "Something fruity", name: "Free coffee", price: 1, userId: "auth0|evil" },
      sink,
    ).then((result) => {
      expect(result.failed).toBe(false);
      expect(result.content).not.toContain("Free coffee");
      expect(result.content).not.toContain("auth0|evil");
      const cards = sink.products.mock.calls[0]?.[0] as { price: number; name: string }[];
      expect(cards[0]?.price).toBe(1800);
      expect(cards[0]?.name).not.toBe("Free coffee");
    });
  });
});
