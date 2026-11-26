const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;

/** Where the Pelita storefront sends a shopper after login or logout. */
export const PELITA_RETURN_PATH = "/pelita";
/** Partner-store yuu shelf. Unlisted skus, including the demand-gap product, are bought here. */
export const PELITA_YUU_PATH = "/pelita/yuu";

export const PELITA_SIGN_IN_HREF = authHref("/auth/login", PELITA_RETURN_PATH);
/** Every Pelita sign-out. Auth0 allowlists this path exactly, not `/pelita/yuu`. */
export const PELITA_SIGN_OUT_HREF = authHref("/auth/logout", PELITA_RETURN_PATH);
export const PELITA_YUU_SIGN_IN_HREF = authHref("/auth/login", PELITA_YUU_PATH);

/**
 * A same-origin path, query, and hash. Absolute URLs, protocol-relative URLs,
 * and backslash or control-character tricks are refused so `returnTo` cannot
 * leave this host.
 */
export function safeRelativeReturnTo(value: string): string | null {
  if (value.length === 0 || value.length > 2048) return null;
  if (CONTROL.test(value) || /[\s\\]/.test(value)) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (CONTROL.test(decoded) || decoded.includes("\\")) return null;
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(value, "https://returnto.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://returnto.invalid") return null;

  const path = `${url.pathname}${url.search}${url.hash}`;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  if (CONTROL.test(path)) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (CONTROL.test(decodedPath) || decodedPath.includes("\\")) return null;
  if (!decodedPath.startsWith("/") || decodedPath.startsWith("//")) return null;
  return path;
}

/** HTTPS profile image with no embedded credentials. Anything else is dropped. */
export function safeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return undefined;
  if (CONTROL.test(value) || /[\s\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function authHref(path: "/auth/login" | "/auth/logout", returnTo: string): string {
  const safe = safeRelativeReturnTo(returnTo);
  if (!safe) throw new Error("returnTo must be a same-origin relative path");
  return `${path}?${new URLSearchParams({ returnTo: safe }).toString()}`;
}
