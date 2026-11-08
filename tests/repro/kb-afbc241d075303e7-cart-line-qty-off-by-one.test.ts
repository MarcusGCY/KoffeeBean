import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { itemCount } from "@/lib/cart";
import { addToCart } from "@/lib/store-meta";
import type { CartItem } from "@/lib/types";

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

describe("cart line quantity", () => {
  beforeEach(() => {
    db.meta = {};
    db.patches = [];
  });

  it("stores a single unit when the shopper adds one item", async () => {
    const cart = await addToCart("auth0|shopper", "mug", 1);
    expect(cart).toMatchObject({ items: [{ productId: "mug", qty: 1 }] });
    const lines: CartItem[] = cart.items.map((item) => ({
      productId: item.productId,
      quantity: item.qty,
    }));
    expect(itemCount(lines)).toBe(1);
  });

  it("renders the cart line multiplier from the stored quantity", () => {
    const store = readFileSync("src/components/Store.tsx", "utf8");
    expect(store).toMatch(/× \{item\.qty\}/);
    expect(store).not.toMatch(/× \{item\.qty \+ 1\}/);
  });
});
