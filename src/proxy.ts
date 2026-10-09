import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth0Configured, getAuth0 } from "./lib/auth0";
import { isAdminUser } from "./lib/demo-auth";

function notFound(): NextResponse {
  return new NextResponse("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}

function isDemoSurface(pathname: string): boolean {
  return pathname === "/admin/demo" || pathname.startsWith("/admin/demo/") || pathname.startsWith("/api/demo/");
}

export async function proxy(request: NextRequest) {
  const demo = isDemoSurface(request.nextUrl.pathname);
  // Signed revert/reset grants are checked in the route. They have no Auth0 session.
  const signedPost = request.method === "POST" && request.nextUrl.pathname.startsWith("/api/demo/");

  if (!auth0Configured()) {
    if (demo && !signedPost) return notFound();
    if (request.nextUrl.pathname.startsWith("/auth/")) {
      return new NextResponse(
        "Auth0 is not configured. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, and APP_BASE_URL in .env.local, then restart the server.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return NextResponse.next();
  }

  const authResponse = await getAuth0().middleware(request);
  if (!demo || signedPost) return authResponse;

  try {
    const session = await getAuth0().getSession(request);
    if (isAdminUser(session?.user)) return authResponse;
  } catch (error) {
    console.error("[demo] session check failed", error);
  }
  return notFound();
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
