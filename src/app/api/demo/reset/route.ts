import { NextResponse } from "next/server";
import { isSameOrigin, verifyDemoCsrf, verifyResetGrant } from "@/lib/demo-auth";
import { resetDemoBugs } from "@/lib/demo-actions";
import { githubDemoRepo, publicGitHubError } from "@/lib/demo-repo";
import { readAdmin } from "@/lib/demo-session";

export async function POST(req: Request) {
  const { csrf, token } = await readFields(req);
  let granted = false;
  try {
    granted = Boolean(token && verifyResetGrant(token));
  } catch (error) {
    console.error("[demo] reset grant check failed", error);
  }
  if (!granted) {
    const admin = await readAdmin();
    if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!isSameOrigin(req)) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }
    let csrfOk = false;
    try {
      csrfOk = Boolean(csrf && verifyDemoCsrf(admin.id, csrf));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cannot verify the form.";
      return NextResponse.json({ error: message }, { status: 503 });
    }
    if (!csrfOk) {
      return NextResponse.json(
        { error: "The form expired. Reload the page and try again." },
        { status: 403 },
      );
    }
  }

  try {
    const result = await resetDemoBugs(githubDemoRepo());
    if (granted || wantsJson(req)) return NextResponse.json(result);
    return redirectDemo(req, result.flash, result.detail);
  } catch (error) {
    console.error("[demo] reset failed", error);
    const detail = publicGitHubError(error);
    if (granted || wantsJson(req)) return NextResponse.json({ flash: "error", detail }, { status: 500 });
    return redirectDemo(req, "error", detail);
  }
}

async function readFields(req: Request): Promise<{ csrf?: string; token?: string }> {
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token") ?? undefined;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    return {
      csrf: typeof record.csrf === "string" ? record.csrf : undefined,
      token: typeof record.token === "string" ? record.token : queryToken,
    };
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    const csrf = form.get("csrf");
    const token = form.get("token");
    return {
      csrf: typeof csrf === "string" ? csrf : undefined,
      token: typeof token === "string" ? token : queryToken,
    };
  }
  return { token: queryToken };
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
