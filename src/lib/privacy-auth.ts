import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const NO_STORE = { "cache-control": "private, no-store" };

export function privacyJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function matches(provided: string, secret: string): boolean {
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(secret).digest());
}

/**
 * Null when the caller holds `PRIVACY_MAINTENANCE_SECRET`; otherwise the 503 or 401 to return. This is a
 * separate secret from `BI_API_SECRET` on purpose: the BI bot reads, it must not be able to delete or rewrite.
 * Unset means closed (503), never open.
 */
export function requirePrivacySecret(req: Request): NextResponse | null {
  const secret = process.env.PRIVACY_MAINTENANCE_SECRET?.trim() ?? "";
  if (secret.length < 16) return privacyJson({ error: "unconfigured" }, 503);
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!bearer || !matches(bearer, secret)) return privacyJson({ error: "unauthorized" }, 401);
  return null;
}
