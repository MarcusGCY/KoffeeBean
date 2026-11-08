import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, applyCoupon } from "@/lib/store-meta";

const db = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
  patches: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.patches.push(structuredClone(patch));
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

describe("coupon code in cart", () => {
  beforeEach(() => {
    db.meta = {};
    db.patches = [];
  });

  it("reflects SAVE10 on the cart totals when the coupon is applied with items", async () => {
    await addToCart("auth0|shopper", "mug", 1);
    const cart = await applyCoupon("auth0|shopper", "SAVE10");
    expect(cart).toMatchObject({ coupon: "SAVE10", subtotalCents: 1400, discountCents: 140, totalCents: 1361 });
  });

  it("syncs the typed coupon when the shopper presses Enter in the coupon field", () => {
    const store = readFileSync("src/components/Store.tsx", "utf8");
    expect(store).toMatch(/onKeyDown=\{[\s\S]*void syncCoupon\(\);[\s\S]*\}[\s\S]*placeholder="Coupon code"/);
    expect(store).toMatch(/if \(e\.key === "Enter"\)[\s\S]*void syncCoupon\(\)/);
  });
});
