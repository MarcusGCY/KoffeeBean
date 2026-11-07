import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToCart } from "@/lib/store-meta";

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

describe("add to cart buttons", () => {
  beforeEach(() => {
    db.meta = {};
    db.patches = [];
  });

  it("persists a mug when the API receives a real catalog product id", async () => {
    const cart = await addToCart("auth0|shopper", "mug", 1);
    expect(cart).toMatchObject({ items: [{ productId: "mug", qty: 1 }] });
    expect(db.patches).toHaveLength(1);
  });

  it("wires every Add to cart button to that product's catalog id", () => {
    const store = readFileSync("src/components/Store.tsx", "utf8");
    expect(store).toMatch(/onClick=\{\(\) => onAdd\(p\.id\)\}/);
  });
});
