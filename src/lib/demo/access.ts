import { PRESENTER_COOKIE, presenterSecret, verifyPresenterToken } from "./presenter";
import { demoTrack } from "./track";

/** The gate is open only when the track flag is exactly "pelita" and a signing secret is set. */
export function demoEnabled(): boolean {
  return demoTrack() === "pelita" && presenterSecret() !== "";
}

export function cookieFromHeader(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function presenterTokenOk(token: string | undefined): boolean {
  return demoEnabled() && verifyPresenterToken(token, presenterSecret());
}

export function presenterCookieOk(cookieHeader: string | null): boolean {
  return presenterTokenOk(cookieFromHeader(cookieHeader, PRESENTER_COOKIE));
}

export function isPelitaPage(pathname: string): boolean {
  return pathname === "/demo/pelita" || pathname.startsWith("/demo/pelita/");
}

/**
 * Page-level check for the proxy, so a closed gate is a real 404 status
 * rather than a not-found screen streamed after a 200. The enter route
 * verifies its own link token.
 */
export function pelitaPageAllowed(pathname: string, cookieHeader: string | null): boolean {
  if (!demoEnabled()) return false;
  if (pathname === "/demo/pelita/enter") return true;
  return presenterCookieOk(cookieHeader);
}
