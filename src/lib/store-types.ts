import type { OrderStatus } from "./order-status";

export type CartLine = { productId: string; qty: number };

export type CartSnapshot = {
  items: CartLine[];
  coupon: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

export type OrderSummary = {
  id: string;
  createdAt: string;
  status: OrderStatus;
  cancellable: boolean;
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  coupon: string | null;
};

export type OrderDetail = OrderSummary & {
  items: { productId: string; name: string; unitPriceCents: number; qty: number }[];
};
