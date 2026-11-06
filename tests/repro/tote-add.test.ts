import { describe, expect, it } from "vitest";
import { addItem } from "@/lib/cart";

describe("Canvas Tote Bag add to cart", () => {
  it("adds the ceramic mug to an empty cart", () => {
    expect(addItem([], "mug")).toEqual([{ productId: "mug", quantity: 1 }]);
  });

  it("adds the canvas tote bag when the shopper clicks Add to Cart", () => {
    expect(addItem([], "tote")).toEqual([{ productId: "tote", quantity: 1 }]);
  });
});
