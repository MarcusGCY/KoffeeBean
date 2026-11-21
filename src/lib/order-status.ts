export type OrderStatus = "cancelled" | "placed" | "packed" | "shipped" | "delivered";

const MINUTE = 60 * 1000;

/** How long after placing an order the shopper can still cancel (undo) it. */
export const UNDO_WINDOW_MS = 10 * MINUTE;

export function undoDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UNDO_WINDOW_MS);
}

/**
 * Demo fulfilment clock, derived when an order is read.
 * Cancelled wins. Otherwise: placed under 2 minutes, packed under 10,
 * shipped under 30, then delivered.
 */
export function orderStatus(createdAt: Date, cancelledAt: Date | null, now = new Date()): OrderStatus {
  if (cancelledAt) return "cancelled";
  const elapsed = now.getTime() - createdAt.getTime();
  if (elapsed < 2 * MINUTE) return "placed";
  if (elapsed < UNDO_WINDOW_MS) return "packed";
  if (elapsed < 30 * MINUTE) return "shipped";
  return "delivered";
}

/** Shoppers can cancel only while the order is still placed or packed. */
export function canCancel(status: OrderStatus): boolean {
  return status === "placed" || status === "packed";
}
