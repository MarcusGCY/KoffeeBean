import { describe, expect, it } from "vitest";
import { addItem, removeItem, total, discount } from "@/lib/cart";
import type { CartItem } from "@/lib/types";

describe("coupons", () => {
  const cart: CartItem[] = [{ productId: "mug", quantity: 1 }]; // 1400

  it("applies SAVE10", () => {
    expect(discount(cart, "SAVE10")).toBe(140);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(discount(cart, "save10")).toBe(140);
    expect(discount(cart, "  Save10 ")).toBe(140);
  });

  it("ignores unknown codes", () => {
    expect(discount(cart, "NOPE")).toBe(0);
  });
});

describe("totals", () => {
  it("multiplies price by quantity", () => {
    const cart: CartItem[] = [{ productId: "tote", quantity: 3 }]; // 3 x 1200
    expect(total(cart).subtotal).toBe(3600);
  });

  it("adds 8% tax after discount", () => {
    const cart: CartItem[] = [{ productId: "mug", quantity: 1 }];
    const t = total(cart, "SAVE10"); // 1400 - 140 = 1260, tax 101
    expect(t).toEqual({ subtotal: 1400, discount: 140, tax: 101, total: 1361 });
  });
});

describe("removing items", () => {
  it("drops the line when quantity reaches zero", () => {
    let cart = addItem([], "mug");
    cart = removeItem(cart, "mug");
    expect(cart).toEqual([]);
    expect(total(cart).total).toBe(0);
  });

  it("only decrements when quantity is above one", () => {
    let cart = addItem(addItem([], "mug"), "mug");
    cart = removeItem(cart, "mug");
    expect(cart).toEqual([{ productId: "mug", quantity: 1 }]);
  });
});
