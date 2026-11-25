import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { isSameOrigin } from "../demo-auth";
import { demoEnabled } from "./access";

export { demoEnabled };

export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
}

/**
 * Null when the Pelita track is on, otherwise the 404 to return.
 * A presenter cookie is not required. Reading the request keeps the handler
 * on the incoming request, so the track flag is not frozen at build time.
 */
export function guardDemoApi(req: Request): NextResponse | null {
  req.headers.get("cookie");
  return demoEnabled() ? null : notFoundResponse();
}

/** Like guardDemoApi for writes: also refuses cross-site requests. */
export function guardDemoWrite(req: Request): NextResponse | null {
  const denied = guardDemoApi(req);
  if (denied) return denied;
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }
  return null;
}

/** For pages: a 404 unless the Pelita track gate is open. The presenter cookie is not required. */
export async function requirePresenterPage(): Promise<void> {
  if (!demoEnabled()) notFound();
}
