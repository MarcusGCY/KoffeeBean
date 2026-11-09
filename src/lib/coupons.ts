export type Coupon = { code: string; percentOff: number };

export const COUPONS: Coupon[] = [
  { code: "SAVE10", percentOff: 10 },
  { code: "BEAN20", percentOff: 20 },
  { code: "BEANS20", percentOff: 20 },
  { code: "WELCOM10", percentOff: 10 },
];

export function findCoupon(input: string): Coupon | undefined {
  const code = input.trim().toUpperCase();
  return COUPONS.find((c) => c.code === code);
}
