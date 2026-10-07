import { Auth0Client } from "@auth0/nextjs-auth0/server";

/**
 * Auth0 session client (v4). `src/proxy.ts` mounts `/auth/login`, `/auth/logout`,
 * and `/auth/callback`.
 *
 * Created on first use so `next build` does not construct the client (and warn)
 * while Auth0 env vars are still empty. At runtime the SDK reads `.env.local`.
 */
let client: Auth0Client | undefined;

export function getAuth0(): Auth0Client {
  client ??= new Auth0Client();
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
