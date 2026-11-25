import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth0Configured, getAuth0 } from "./lib/auth0";
import { isAdminUser } from "./lib/demo-auth";
import { isPelitaPage, pelitaPageAllowed } from "./lib/demo/access";
import { prepareAuthReturnTo } from "./lib/auth-return";

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
  // Pelita pages and /api/demo/pelita/* use the track gate. They are not admin surfaces.
  if (pathname.startsWith("/api/demo/pelita/")) return false;
  return pathname === "/admin/demo" || pathname.startsWith("/admin/demo/") || pathname.startsWith("/api/demo/");
}

function isOwnerSurface(pathname: string): boolean {
  return isDemoSurface(pathname)
    || pathname === "/admin/quality"
    || pathname.startsWith("/admin/quality/")
    || pathname === "/api/quality/audit";
}

export async function proxy(request: NextRequest) {
  if (isPelitaPage(request.nextUrl.pathname) && !pelitaPageAllowed(request.nextUrl.pathname)) {
    return notFound();
  }
  // Login and logout accept only a same-origin relative returnTo. Logout is
  // expanded to an absolute URL on this app's origin before the SDK sees it.
  const prepared = prepareAuthReturnTo(request);
  if (prepared instanceof NextResponse) return prepared;

  const demo = isOwnerSurface(prepared.nextUrl.pathname);
  // Signed revert/reset grants are checked in the route. They have no Auth0 session.
  const signedPost = prepared.method === "POST" && prepared.nextUrl.pathname.startsWith("/api/demo/");

  if (!auth0Configured()) {
    if (demo && !signedPost) return notFound();
    if (prepared.nextUrl.pathname.startsWith("/auth/")) {
      return new NextResponse(
        "Auth0 is not configured. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, and APP_BASE_URL in .env.local, then restart the server.",
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return NextResponse.next();
  }

  const authResponse = await getAuth0().middleware(prepared);
  if (!demo || signedPost) return authResponse;

  try {
    const session = await getAuth0().getSession(prepared);
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
