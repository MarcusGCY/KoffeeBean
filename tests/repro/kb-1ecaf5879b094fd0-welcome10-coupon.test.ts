import { describe, expect, it } from "vitest";
import { discount } from "@/lib/cart";
import { findCoupon } from "@/lib/coupons";
import type { CartItem } from "@/lib/types";

describe("WELCOME10 coupon", () => {
  const cart: CartItem[] = [{ productId: "mug", quantity: 1 }]; // 1400

  it("applies SAVE10 as a control", () => {
    expect(findCoupon("SAVE10")).toMatchObject({ code: "SAVE10", percentOff: 10 });
    expect(discount(cart, "SAVE10")).toBe(140);
  });

  it("recognizes WELCOME10 and applies a 10% discount", () => {
    expect(findCoupon("WELCOME10")).toMatchObject({ code: "WELCOME10", percentOff: 10 });
    expect(discount(cart, "WELCOME10")).toBe(140);
  });
});
