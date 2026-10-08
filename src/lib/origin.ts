/**
 * Public origin for Auth0 and for approve/reject links.
 *
 * Explicit APP_URL / APP_BASE_URL win. On Vercel they can be unset: preview
 * deployments use this deployment's VERCEL_URL, and production falls back to
 * VERCEL_PROJECT_PRODUCTION_URL, then VERCEL_URL. Vercel sets those itself.
 */

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/$/, "");
  return trimmed || undefined;
}

function hostUrl(host: string | undefined): string | undefined {
  const trimmed = clean(host);
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `https://${trimmed}`;
}

function vercelFallback(): string | undefined {
  if (process.env.VERCEL_ENV === "preview") {
    const preview = hostUrl(process.env.VERCEL_URL);
    if (preview) return preview;
  }
  return hostUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) || hostUrl(process.env.VERCEL_URL);
}

/** Origin baked into approve/reject links. */
export function appOrigin(): string {
  const explicit = clean(process.env.APP_URL) || clean(process.env.APP_BASE_URL) || vercelFallback();
  if (!explicit) throw new Error("Missing env var APP_URL");
  return explicit;
}

/**
 * Origin passed to the Auth0 SDK. Prefers APP_BASE_URL, then APP_URL, then
 * the same Vercel host fallback as `appOrigin`. Undefined only off Vercel
 * with neither variable set, so the SDK can infer a local host from the request.
 */
export function auth0BaseUrl(): string | undefined {
  return clean(process.env.APP_BASE_URL) || clean(process.env.APP_URL) || vercelFallback();
}
