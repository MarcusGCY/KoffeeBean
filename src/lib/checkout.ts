import type { CartItem } from "./types";
import { total } from "./cart";

export type Order = {
  id: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
};

/** Place an order for the current cart. An empty cart does not check out. */
export function checkout(cart: CartItem[], couponCode = ""): Order | null {
  const items = cart
    .filter((item) => item.quantity > 0)
    .map((item) => ({ productId: item.productId, quantity: item.quantity }));
  if (items.length === 0) return null;

  return {
    id: newOrderId(),
    items,
    ...total(items, couponCode),
  };
}

function newOrderId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `BB-${suffix}`;
}
