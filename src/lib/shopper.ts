import { cookies } from "next/headers";
import { auth0Configured, getAuth0 } from "./auth0";
import type { Shopper } from "./types";

export type { Shopper };

/**
 * Current signed-in shopper, or null.
 * `cookies()` keeps this request-time under Cache Components so a missing
 * Auth0 env at build time is not baked into the static page.
 */
export async function getShopper(): Promise<Shopper | null> {
  await cookies();
  if (!auth0Configured()) return null;

  const session = await getAuth0().getSession();
  const user = session?.user;
  if (!user?.sub) return null;

  return {
    id: user.sub,
    email: user.email,
    name: user.name,
  };
}

/** Stable needle so rate limiting can count this shopper's reports in GitHub text. */
export function reporterIdMarker(userId: string): string {
  return `**Auth0 user id:** \`${userId}\``;
}

export function reporterBlock(shopper: Shopper): string {
  const who =
    shopper.name && shopper.email
      ? `${shopper.name} (${shopper.email})`
      : shopper.email || shopper.name || "signed-in shopper";
  return `**Reported by:** ${who}\n${reporterIdMarker(shopper.id)}`;
}
