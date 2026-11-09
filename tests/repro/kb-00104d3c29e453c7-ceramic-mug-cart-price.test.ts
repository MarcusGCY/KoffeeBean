import { describe, expect, it } from "vitest";
import { addItem, getProduct, total } from "@/lib/cart";

describe("BeanBox Ceramic Mug cart price", () => {
  it("lists the mug at $14 on the catalog", () => {
    expect(getProduct("mug")).toMatchObject({ price: 1400 });
  });

  it("uses the catalog price in cart totals when the mug is added", () => {
    const cart = addItem([], "mug");
    expect(total(cart).subtotal).toBe(1400);
  });
});
