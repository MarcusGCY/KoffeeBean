import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { proposeAction } from "@/lib/pending-action";
import { getCart, getOrder, listOrders } from "@/lib/store-meta";
import {
  faqAnswer,
  getOrderStatus,
  listMyOrders,
  listProducts,
  proposeAddToCart,
  viewCart,
} from "../support-agent/bot/lib/shop";

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
}));

const real = { principalId: "auth0|real", authenticator: "bearer", principalType: "user" as const };
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
    expect(getCart).toHaveBeenCalledWith("auth0|real");
    await listProducts(real, evil);
    await listMyOrders(real, evil);
    await getOrderStatus(real, { ...evil, orderId: "BB-TEST1" });
    await faqAnswer(real, evil);
    expect(listOrders).toHaveBeenCalledWith("auth0|real");
    expect(getOrder).toHaveBeenCalledWith("auth0|real", "BB-TEST1");
    await expect(getOrderStatus(null, { userId: "auth0|evil", orderId: "BB-1" })).rejects.toThrow("no_customer");

    for (const name of ["faq_answer", "list_products", "view_cart", "list_my_orders", "get_order_status"]) {
      const source = readFileSync(path.join(process.cwd(), "support-agent/bot/tools", `${name}.ts`), "utf8");
      expect(source).toContain('effect: "read"');
      expect(source).toContain("ctx.session.auth");
      expect(source).not.toContain("input.userId");
    }
    for (const name of [
      "add_to_cart",
      "update_cart_qty",
      "remove_from_cart",
      "apply_coupon",
      "place_order",
      "cancel_order",
      "report_problem",
    ]) {
      const source = readFileSync(path.join(process.cwd(), "support-agent/bot/tools", `${name}.ts`), "utf8");
      expect(source).toContain('effect: "write"');
      expect(source).toContain("ctx.session.auth");
      expect(source).not.toContain("store-meta");
    }
  });

  it("prepares a confirm action for the principal and does not pass a model userId", async () => {
    const result = await proposeAddToCart(real, { userId: "auth0|evil", productId: "mug", qty: 1 });
    expect(result).toMatchObject({ pending: true, actionId: "signed" });
    expect(proposeAction).toHaveBeenCalledWith("auth0|real", { op: "add_to_cart", productId: "mug", qty: 1 });
  });
});
