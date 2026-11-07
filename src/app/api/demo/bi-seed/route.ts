import { NextResponse } from "next/server";
import { biDbConfigured, getBiSql } from "@/lib/bi-db";
import { seedBiDemoStory } from "@/lib/bi-demo-seed";
import { BiHashConfigError } from "@/lib/bi-hash";
import { isSameOrigin, verifyDemoCsrf } from "@/lib/demo-auth";
import { readAdmin } from "@/lib/demo-session";

/**
 * Admin-only (Auth0 `admin` role) seed of synthetic `source=demo` analytics rows
 * in the BI event store. Never touches `live` rows, Auth0 `app_metadata`, carts,
 * or orders. No signed bot grant: the admin session and CSRF token are required.
 */
export async function POST(req: Request) {
  const admin = await readAdmin();
  if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  const csrf = await readCsrf(req);
  let csrfOk = false;
  try {
    csrfOk = Boolean(csrf && verifyDemoCsrf(admin.id, csrf));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cannot verify the form.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
  if (!csrfOk) {
    return NextResponse.json({ error: "The form expired. Reload the page and try again." }, { status: 403 });
  }

  const json = wantsJson(req);
  const sql = biDbConfigured() ? getBiSql() : null;
  if (!sql) return fail(req, json, "bi-error", "BI database is not configured (DATABASE_URL).", 503);

  try {
    const result = await seedBiDemoStory(sql);
    const detail = `Seeded ${result.events} demo events and ${result.orders} demo order mirrors (source=demo). Live rows were not touched.`;
    if (json) return NextResponse.json({ flash: "bi-seeded", detail, ...result });
    return redirectDemo(req, "bi-seeded", detail);
  } catch (error) {
    if (error instanceof BiHashConfigError) {
      return fail(req, json, "bi-error", "BI_HASH_SECRET is not configured (16+ characters).", 503);
    }
    console.error("[demo] bi seed failed", error instanceof Error ? error.name : "unknown");
    return fail(req, json, "bi-error", "Could not seed the BI demo story. Neon rejected the write.", 500);
  }
}

function fail(req: Request, json: boolean, flash: string, detail: string, status: number) {
  if (json) return NextResponse.json({ flash, detail }, { status });
  return redirectDemo(req, flash, detail);
}

async function readCsrf(req: Request): Promise<string | undefined> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const value = body && typeof body === "object" ? (body as Record<string, unknown>).csrf : undefined;
    return typeof value === "string" ? value : undefined;
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const value = (await req.formData()).get("csrf");
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function wantsJson(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").includes("application/json");
}

function redirectDemo(req: Request, flash: string, detail: string) {
  const url = new URL("/admin/demo", publicOrigin(req));
  url.searchParams.set("flash", flash);
  url.searchParams.set("detail", detail.replace(/\s+/g, " ").trim().slice(0, 300));
  return NextResponse.redirect(url, 303);
}

function publicOrigin(req: Request): string {
  try {
    const url = new URL(req.url);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
  } catch {
    /* fall through to forwarded headers */
  }
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}
