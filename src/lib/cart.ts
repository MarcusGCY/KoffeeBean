import products from "@/data/products.json";
import type { CartItem, Product } from "./types";
import { findCoupon } from "./coupons";

const catalog = products as Product[];
const TAX_RATE = 0.08;

export function getProduct(id: string): Product | undefined {
  return catalog.find((p) => p.id === id);
}

export function addItem(cart: CartItem[], productId: string): CartItem[] {
  const existing = cart.find((i) => i.productId === productId);
  if (existing) {
    return cart.map((i) =>
      i.productId === productId ? { ...i, quantity: i.quantity + 1 } : i,
    );
  }
  return [...cart, { productId, quantity: 1 }];
}

export function removeItem(cart: CartItem[], productId: string): CartItem[] {
  return cart
    .map((i) => (i.productId === productId ? { ...i, quantity: i.quantity - 1 } : i))
    .filter((i) => i.quantity > 0);
}

export function subtotal(cart: CartItem[]): number {
  return cart.reduce((sum, i) => {
    const p = getProduct(i.productId);
    if (!p) return sum;
    return sum + p.price * i.quantity;
  }, 0);
}

export function itemCount(cart: CartItem[]): number {
  return cart.reduce((n, i) => n + i.quantity, 0);
}

export function discount(cart: CartItem[], couponCode: string): number {
  const coupon = findCoupon(couponCode);
  if (!coupon) return 0;
  return Math.round((subtotal(cart) * coupon.percentOff) / 100);
}

export function total(cart: CartItem[], couponCode = "") {
  const sub = subtotal(cart);
  const disc = discount(cart, couponCode);
  const tax = Math.round((sub - disc) * TAX_RATE);
  return { subtotal: sub, discount: disc, tax, total: sub - disc + tax };
}
