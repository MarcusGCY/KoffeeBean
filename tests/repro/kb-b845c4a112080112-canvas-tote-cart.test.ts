import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart, setCartQty } from "@/lib/store-meta";

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

describe("canvas tote cart regression", () => {
  beforeEach(() => {
    db.meta = {};
    db.patches = [];
  });

  it("adds a mug to the cart", async () => {
    const cart = await addToCart("auth0|shopper", "mug", 1);
    expect(cart).toMatchObject({ items: [{ productId: "mug", qty: 1 }] });
  });

  it("adds the canvas tote and keeps tote quantity when a mug is also in the cart", async () => {
    const added = await addToCart("auth0|shopper", "tote", 1);
    expect(added).toMatchObject({ items: [{ productId: "tote", qty: 1 }] });
    expect(db.patches).toHaveLength(1);

    const now = new Date("2026-10-31T01:00:00.000Z");
    db.patches = [];
    const tote = await setCartQty("auth0|shopper", "tote", 2, now);
    expect(tote).toMatchObject({ items: [{ productId: "tote", qty: 2 }] });
    expect(db.patches).toHaveLength(1);

    const mug = await setCartQty("auth0|shopper", "mug", 2, now);
    expect(mug).toMatchObject({
      items: [
        { productId: "tote", qty: 2 },
        { productId: "mug", qty: 2 },
      ],
    });
  });
});
