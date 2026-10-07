import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth0Configured, getAuth0 } from "./lib/auth0";

export async function proxy(request: NextRequest) {
  if (!auth0Configured()) {
    if (request.nextUrl.pathname.startsWith("/auth/")) {
      return new NextResponse(
        "Auth0 is not configured. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, and APP_BASE_URL in .env.local, then restart the server.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return NextResponse.next();
  }

  return getAuth0().middleware(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets. The SDK needs this
     * matcher so it can mount /auth/* and roll the session cookie.
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
