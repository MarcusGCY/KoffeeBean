import { describe, expect, it } from "vitest";
import { getProduct, total } from "@/lib/cart";
import { loadFaq } from "@/lib/faq";

describe("Roast Day T-Shirt catalog price", () => {
  it("lists the canvas tote at the FAQ merch price", () => {
    expect(getProduct("tote")?.price).toBe(1200);
    expect(loadFaq()).toContain("Canvas Tote Bag ($12.00");
  });

  it("lists the roast day tee at the FAQ merch price and checkout total", () => {
    expect(loadFaq()).toContain("Roast Day T-Shirt ($25.00");
    expect(getProduct("tee")?.price).toBe(2500);
    expect(total([{ productId: "tee", quantity: 1 }])).toEqual({
      subtotal: 2500,
      discount: 0,
      tax: 200,
      total: 2700,
    });
  });
});
