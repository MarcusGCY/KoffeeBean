import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { biDbConfigured } from "@/lib/bi-db";
import { readSignedInBalance, readYuuPanel } from "./db";
import { tierForPoints } from "./tier";
import type { StorefrontYuu, YuuPanel, YuuPersonaChoice } from "./types";

function choice(points: number): YuuPersonaChoice {
  return { id: "self", displayName: "You", points, tier: tierForPoints(points) };
}

/** The signed-in shopper's own balance. No persona list. */
export async function loadStorefrontYuu(memberKey: string | null): Promise<StorefrontYuu> {
  if (!memberKey || !mgmtConfigured()) return { signedInMember: null };
  try {
    const account = await readSignedInBalance(memberKey);
    if (!account) return { signedInMember: null };
    return { signedInMember: choice(account.points) };
  } catch (error) {
    console.error("[yuu] storefront read failed", error instanceof Error ? error.name : "unknown");
    return { signedInMember: null };
  }
}

/** Ops panel. Null when Neon is not configured, so the page does not call out. */
export async function loadYuuPanel(): Promise<YuuPanel | null> {
  if (!biDbConfigured()) return null;
  try {
    return await readYuuPanel();
  } catch (error) {
    console.error("[yuu] panel read failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
