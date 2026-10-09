import { cookies } from "next/headers";
import { auth0Configured, getAuth0 } from "./auth0";
import { isAdminUser } from "./demo-auth";

export type AdminPrincipal = { id: string; email: string };

/**
 * Signed-in user whose roles claim contains `admin`. Missing session, a user
 * without that role, and an Auth0 email explicitly marked unverified all
 * return null. Callers respond with 404 so the public site does not reveal
 * this route.
 */
export async function readAdmin(): Promise<AdminPrincipal | null> {
  await cookies();
  if (!auth0Configured()) return null;
  const session = await getAuth0().getSession();
  const user = session?.user;
  if (!isAdminUser(user)) return null;
  return { id: user.sub, email: user.email };
}
