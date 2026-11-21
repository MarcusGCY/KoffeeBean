/**
 * The demo shopper is whichever Auth0 `sub` is set in `DEMO_SHOPPER_SUB`.
 * Nothing in code names a real account. Unset means there is no demo shopper.
 */
export function demoShopperSub(): string | null {
  const sub = (process.env.DEMO_SHOPPER_SUB ?? "").trim();
  return sub === "" ? null : sub;
}

export function isDemoShopperSub(sub: string): boolean {
  const configured = demoShopperSub();
  return configured !== null && configured === sub;
}
