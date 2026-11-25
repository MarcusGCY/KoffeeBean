import { NextResponse } from "next/server";
import { demoEnabled, notFoundResponse } from "@/lib/demo/guard";
import { PRESENTER_COOKIE, presenterSecret, tokenExpiry, verifyPresenterToken } from "@/lib/demo/presenter";

/** Opens a signed presenter link: sets an httpOnly cookie and drops the token from the URL. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  if (!demoEnabled()) return notFoundResponse();
  const token = url.searchParams.get("k");
  if (!token || !verifyPresenterToken(token, presenterSecret())) return notFoundResponse();

  const response = NextResponse.redirect(new URL("/demo/pelita", url), 303);
  response.cookies.set(PRESENTER_COOKIE, token, {
    httpOnly: true,
    secure: proto === "https",
    sameSite: "lax",
    path: "/",
    expires: new Date(tokenExpiry(token)),
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}
