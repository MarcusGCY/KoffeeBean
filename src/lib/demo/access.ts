import { presenterSecret } from "./presenter";
import { demoTrack } from "./track";

/** The gate is open only when the track flag is exactly "pelita" and a signing secret is set. */
export function demoEnabled(): boolean {
  return demoTrack() === "pelita" && presenterSecret() !== "";
}

/** Public Pelita URLs and the original /demo/pelita pages, including the enter link. */
export function isPelitaPage(pathname: string): boolean {
  return pathname === "/pelita"
    || pathname.startsWith("/pelita/")
    || pathname === "/demo/pelita"
    || pathname.startsWith("/demo/pelita/");
}

/**
 * Page-level check for the proxy, so a closed gate is a real 404 status
 * rather than a not-found screen streamed after a 200. A Pelita path is
 * public when the track gate is open. The presenter cookie is not required.
 * The enter route still verifies its own link token.
 */
export function pelitaPageAllowed(pathname: string): boolean {
  return isPelitaPage(pathname) && demoEnabled();
}
