import { cookies } from "next/headers";
import { auth0Configured, getAuth0 } from "./auth0";
import { isAdminEmail } from "./demo-auth";

export type AdminPrincipal = { id: string; email: string };

/**
 * Signed-in allowlisted owner. Missing session, a non-allowlisted email,
 * and an Auth0 email explicitly marked unverified all return null.
 * Callers respond with 404 so the public site does not reveal this route.
 */
export async function readAdmin(): Promise<AdminPrincipal | null> {
  await cookies();
  if (!auth0Configured()) return null;
  const session = await getAuth0().getSession();
  const user = session?.user;
  if (!user?.sub || typeof user.email !== "string") return null;
  if (user.email_verified === false) return null;
  if (!isAdminEmail(user.email)) return null;
  return { id: user.sub, email: user.email };
}
