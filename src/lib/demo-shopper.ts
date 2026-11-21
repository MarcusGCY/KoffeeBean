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

/** Defensive read of `app_metadata.is_test`: only a literal `true` counts. The one is_test check. */
export function isTestShopper(meta: unknown): boolean {
  return typeof meta === "object" && meta !== null && (meta as { is_test?: unknown }).is_test === true;
}
