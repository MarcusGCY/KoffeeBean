import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, applyCoupon } from "@/lib/store-meta";

const db = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

describe("BEANS20 coupon code", () => {
  beforeEach(() => {
    db.meta = {};
  });

  it("applies BEAN20 for a 20% discount on House Espresso 1kg", async () => {
    await addToCart("auth0|shopper", "espresso-1kg", 1); // 4200
    const cart = await applyCoupon("auth0|shopper", "BEAN20");
    expect(cart).toMatchObject({ coupon: "BEAN20", subtotalCents: 4200, discountCents: 840, totalCents: 3629 });
  });

  it("accepts BEANS20 and applies the 20% discount", async () => {
    await addToCart("auth0|shopper", "espresso-1kg", 1); // 4200
    const cart = await applyCoupon("auth0|shopper", "BEANS20");
    expect(cart).toMatchObject({ coupon: "BEANS20", subtotalCents: 4200, discountCents: 840, totalCents: 3629 });
  });
});
