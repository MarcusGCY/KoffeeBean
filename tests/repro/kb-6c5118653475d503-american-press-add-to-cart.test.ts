import { describe, expect, it } from "vitest";
import { addItem, getProduct, total } from "@/lib/cart";

describe("American Press add to cart", () => {
  it("lists American Press in the catalog", () => {
    expect(getProduct("american-press")).toMatchObject({
      name: "American Press",
      price: 2000,
    });
  });

  it("adds American Press to the cart when the shopper clicks Add to cart", () => {
    const cart = addItem([], "american-press");
    expect(cart).toEqual([{ productId: "american-press", quantity: 1 }]);
    expect(total(cart).subtotal).toBe(2000);
  });
});
