import { StoreUnavailableError } from "./store-error";

/**
 * Auth0 Management API client for the shop's M2M application.
 * Tokens are cached until shortly before `expires_in`.
 * `patchAppMetadata` sends only the top-level keys in `patch`. Auth0 merges
 * top-level `app_metadata` keys and replaces each of those keys entirely.
 */

type CachedToken = { accessToken: string; expiresAt: number };

let cached: CachedToken | undefined;

const REFRESH_EARLY_MS = 60_000;

export function resetManagementTokenCache(): void {
  cached = undefined;
}

export function auth0Domain(): string {
  return (process.env.AUTH0_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

export function mgmtConfigured(): boolean {
  const env = process.env;
  return Boolean(auth0Domain() && env.AUTH0_MGMT_CLIENT_ID?.trim() && env.AUTH0_MGMT_CLIENT_SECRET?.trim());
}

function fail(): never {
  throw new StoreUnavailableError();
}

export async function getManagementToken(now = Date.now()): Promise<string> {
  if (cached && cached.expiresAt - REFRESH_EARLY_MS > now) return cached.accessToken;
  if (!mgmtConfigured()) fail();
  const domain = auth0Domain();
  let response: Response;
  try {
    response = await fetch(`https://${domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: process.env.AUTH0_MGMT_CLIENT_ID?.trim(),
        client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET?.trim(),
        audience: `https://${domain}/api/v2/`,
      }),
    });
  } catch {
    fail();
  }
  if (!response.ok) {
    console.error("[auth0] token status", response.status);
    fail();
  }
  const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) fail();
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 60;
  cached = { accessToken: data.access_token, expiresAt: now + expiresIn * 1000 };
  return data.access_token;
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function userRequest(userId: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const domain = auth0Domain();
  const token = await getManagementToken();
  let response: Response;
  try {
    response = await fetch(`https://${domain}/api/v2/users/${encodeURIComponent(userId)}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    fail();
  }
  if (!response.ok) {
    console.error("[auth0] user status", response.status);
    fail();
  }
  const body = (await response.json()) as { app_metadata?: unknown };
  return metadataObject(body.app_metadata);
}

export async function getAppMetadata(userId: string): Promise<Record<string, unknown>> {
  return userRequest(userId);
}

/** Replaces each top-level key in `patch`. Other top-level keys are left as Auth0 stored them. */
export async function patchAppMetadata(
  userId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return userRequest(userId, {
    method: "PATCH",
    body: JSON.stringify({ app_metadata: patch }),
  });
}
