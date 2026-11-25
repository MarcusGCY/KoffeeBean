import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { NextResponse } from "next/server";
import { isSameOrigin } from "../demo-auth";
import { demoEnabled, presenterCookieOk, presenterTokenOk } from "./access";
import { PRESENTER_COOKIE } from "./presenter";

export { demoEnabled };

export function notFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "cache-control": "private, no-store" } });
}

/** Null when the request may use the demo API, otherwise the 404 to return. */
export function guardDemoApi(req: Request): NextResponse | null {
  return presenterCookieOk(req.headers.get("cookie")) ? null : notFoundResponse();
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

/** For pages: a 404 unless the gate is open and the presenter cookie is valid. */
export async function requirePresenterPage(): Promise<void> {
  if (!demoEnabled()) notFound();
  const jar = await cookies();
  if (!presenterTokenOk(jar.get(PRESENTER_COOKIE)?.value)) notFound();
}
