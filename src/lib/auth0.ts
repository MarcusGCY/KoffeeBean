import { Auth0Client, filterDefaultIdTokenClaims } from "@auth0/nextjs-auth0/server";
import type { User } from "@auth0/nextjs-auth0/types";
import { rolesClaimName } from "./demo-auth";
import { auth0BaseUrl } from "./origin";

/**
 * Auth0 session client (v4). `src/proxy.ts` mounts `/auth/login`, `/auth/logout`,
 * and `/auth/callback`.
 *
 * Created on first use so `next build` does not construct the client (and warn)
 * while Auth0 env vars are still empty. The origin is `APP_BASE_URL` when set,
 * otherwise the Vercel deployment host (see `auth0BaseUrl`).
 *
 * Without `beforeSessionSaved`, v4 stores only a fixed list of ID token claims
 * (`filterDefaultIdTokenClaims`). A namespaced claim such as `https://beanbox/roles`
 * is dropped. The hook runs with the full ID token claims on `session.user` and
 * must put the roles claim back itself.
 */
let client: Auth0Client | undefined;

/** Default ID token claims, plus the configured roles claim when the token has it. */
export function userKeepingRolesClaim(user: User): User {
  const claim = rolesClaimName();
  const filtered = filterDefaultIdTokenClaims(user);
  if (!Object.hasOwn(user, claim)) return filtered;
  return { ...filtered, [claim]: user[claim] };
}

export function getAuth0(): Auth0Client {
  if (!client) {
    const appBaseUrl = auth0BaseUrl();
    client = new Auth0Client({
      ...(appBaseUrl ? { appBaseUrl } : {}),
      async beforeSessionSaved(session) {
        return {
          ...session,
          user: userKeepingRolesClaim(session.user),
        };
      },
    });
  }
  return client;
}

/** True when the four values the SDK needs for a real login are set. */
export function auth0Configured(): boolean {
  // Dynamic lookup so Next does not inline empty values from build time.
  const env = process.env;
  return Boolean(
    env.AUTH0_DOMAIN &&
      env.AUTH0_CLIENT_ID &&
      env.AUTH0_CLIENT_SECRET &&
      env.AUTH0_SECRET,
  );
}
