import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySupportToken } from "@/lib/support-token";
import {
  faqAnswer,
  getOrderStatus,
  listMyOrders,
  listProducts,
  proposeAddToCart,
  viewCart,
} from "../support-agent/bot/lib/shop";

const real = { principalId: "auth0|real", authenticator: "bearer", principalType: "user" as const };
const evil = { userId: "auth0|evil", question: "what is the coupon code?" };

describe("support tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KOFFEEBEAN_URL;
    delete process.env.SUPPORT_AGENT_SECRET;
  });

  it("calls the shop as the session principal and ignores a userId in the model input", async () => {
    process.env.KOFFEEBEAN_URL = "https://shop.example";
    process.env.SUPPORT_AGENT_SECRET = "tool-secret";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/, "") ?? "";
        expect(verifySupportToken(token, "tool-secret")?.userId).toBe("auth0|real");
        expect(token).not.toContain("auth0|evil");
        return Response.json({ ok: true });
      }),
    );

    await faqAnswer(real, evil);
    await listProducts(real, evil);
    await viewCart(real, evil);
    await listMyOrders(real, evil);
    await getOrderStatus(real, { ...evil, orderId: "BB-TEST1" });

    expect(urls).toEqual([
      "https://shop.example/api/agent/faq",
      "https://shop.example/api/agent/products",
      "https://shop.example/api/agent/cart",
      "https://shop.example/api/agent/orders",
      "https://shop.example/api/agent/orders/BB-TEST1",
    ]);
    expect(urls.join(" ")).not.toContain("auth0|evil");
    expect(() => getOrderStatus(null, { userId: "auth0|evil", orderId: "BB-1" })).toThrow("no_customer");

    for (const name of ["faq_answer", "list_products", "view_cart", "list_my_orders", "get_order_status"]) {
      const source = readFileSync(path.join(process.cwd(), "support-agent/bot/tools", `${name}.ts`), "utf8");
      expect(source).toContain('effect: "read"');
      expect(source).toContain("ctx.session.auth");
      expect(source).not.toContain("input.userId");
    }

    const writes = [
      "add_to_cart",
      "update_cart_qty",
      "remove_from_cart",
      "apply_coupon",
      "place_order",
      "cancel_order",
      "report_problem",
    ];
    for (const name of writes) {
      const source = readFileSync(path.join(process.cwd(), "support-agent/bot/tools", `${name}.ts`), "utf8");
      expect(source).toContain('effect: "write"');
      expect(source).toContain("ctx.session.auth");
      expect(source).not.toContain("store-meta");
    }
  });

  it("posts a confirm action for the principal and does not send a model userId", async () => {
    process.env.KOFFEEBEAN_URL = "https://shop.example";
    process.env.SUPPORT_AGENT_SECRET = "tool-secret";
    let body = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://shop.example/api/agent/actions");
        expect(init?.method).toBe("POST");
        body = String(init?.body);
        const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/, "") ?? "";
        expect(verifySupportToken(token, "tool-secret")?.userId).toBe("auth0|real");
        return Response.json({ pending: true, actionId: "signed", summary: "Add 1 mug" });
      }),
    );
    const result = await proposeAddToCart(real, { userId: "auth0|evil", productId: "mug", qty: 1 });
    expect(result).toMatchObject({ pending: true, actionId: "signed" });
    expect(body).not.toContain("auth0|evil");
    expect(JSON.parse(body)).toEqual({ op: "add_to_cart", productId: "mug", qty: 1 });
  });
});
