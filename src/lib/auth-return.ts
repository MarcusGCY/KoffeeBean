import { NextRequest, NextResponse } from "next/server";
import { auth0BaseUrl } from "./origin";
import { safeRelativeReturnTo } from "./return-to";

/**
 * Logout `returnTo` is sent to the identity provider as an absolute URL.
 * Build it from the configured app origin (falling back to this request's
 * origin) so the caller cannot choose the host. The fragment is dropped
 * because the allowlist matches the URL without it.
 */
export function absoluteLogoutReturnTo(relative: string, requestOrigin: string): string | null {
  const safe = safeRelativeReturnTo(relative);
  if (!safe) return null;
  const base = auth0BaseUrl() || requestOrigin;
  try {
    const url = new URL(safe, base);
    if (url.origin !== new URL(base).origin) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function invalidReturnTo(): NextResponse {
  return new NextResponse("Invalid returnTo.", {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

function withReturnTo(request: NextRequest, returnTo: string): NextRequest {
  const url = request.nextUrl.clone();
  url.searchParams.set("returnTo", returnTo);
  return new NextRequest(url, { headers: new Headers(request.headers), method: request.method });
}

/**
 * Pass `/auth/login` and `/auth/logout` through with a safe `returnTo`.
 * A missing `returnTo` is unchanged. An unsafe one is a 400 and is not forwarded.
 * Logout is rewritten to an absolute same-origin URL for the provider allowlist.
 */
export function prepareAuthReturnTo(request: NextRequest): NextRequest | NextResponse {
  const pathname = request.nextUrl.pathname;
  if (pathname !== "/auth/login" && pathname !== "/auth/logout") return request;
  const raw = request.nextUrl.searchParams.get("returnTo");
  if (raw === null) return request;

  const safe = safeRelativeReturnTo(raw);
  if (!safe) return invalidReturnTo();

  if (pathname === "/auth/logout") {
    const absolute = absoluteLogoutReturnTo(safe, request.nextUrl.origin);
    if (!absolute) return invalidReturnTo();
    return withReturnTo(request, absolute);
  }
  if (safe === raw) return request;
  return withReturnTo(request, safe);
}
