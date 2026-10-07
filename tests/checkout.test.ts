import { describe, expect, it } from "vitest";
import { checkout } from "@/lib/checkout";

describe("checkout", () => {
  it("does not place an order for an empty cart", () => {
    expect(checkout([])).toBeNull();
    expect(checkout([{ productId: "mug", quantity: 0 }])).toBeNull();
  });

  it("places an order and charges the cart total", () => {
    const order = checkout([{ productId: "mug", quantity: 1 }], "  save10 ");
    expect(order).toMatchObject({
      items: [{ productId: "mug", quantity: 1 }],
      subtotal: 1400,
      discount: 140,
      tax: 101,
      total: 1361,
    });
    expect(order?.id).toMatch(/^BB-/);
  });
});
