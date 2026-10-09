import { NextResponse } from "next/server";
import { isSameOrigin, verifyDemoCsrf, verifyRevertGrant } from "@/lib/demo-auth";
import { revertMergedFix } from "@/lib/demo-actions";
import { githubDemoRepo, publicGitHubError } from "@/lib/demo-repo";
import { readAdmin } from "@/lib/demo-session";

export async function POST(req: Request) {
  const fields = await readFields(req);
  const pr = fields.pr;
  if (!pr) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let granted = false;
  try {
    granted = Boolean(fields.token && verifyRevertGrant(pr, fields.token));
  } catch (error) {
    console.error("[demo] revert grant check failed", error);
  }
  if (!granted) {
    const admin = await readAdmin();
    if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!isSameOrigin(req)) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }
    let csrfOk = false;
    try {
      csrfOk = Boolean(fields.csrf && verifyDemoCsrf(admin.id, fields.csrf));
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
    const result = await revertMergedFix(githubDemoRepo(), pr, fields.issue);
    if (granted || wantsJson(req)) return NextResponse.json(result);
    return redirectDemo(req, result.flash, result.detail);
  } catch (error) {
    console.error("[demo] revert failed", error);
    const detail = publicGitHubError(error);
    if (granted || wantsJson(req)) return NextResponse.json({ flash: "error", detail }, { status: 500 });
    return redirectDemo(req, "error", detail);
  }
}

async function readFields(req: Request): Promise<{ pr?: number; issue?: number; csrf?: string; token?: string }> {
  const url = new URL(req.url);
  const query = {
    pr: positiveInt(url.searchParams.get("pr")),
    issue: positiveInt(url.searchParams.get("issue")),
    token: url.searchParams.get("token") ?? undefined,
  };
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await req.json().catch(() => null);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    return {
      pr: positiveInt(record.pr) ?? query.pr,
      issue: positiveInt(record.issue) ?? query.issue,
      csrf: typeof record.csrf === "string" ? record.csrf : undefined,
      token: typeof record.token === "string" ? record.token : query.token,
    };
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    const token = form.get("token");
    const csrf = form.get("csrf");
    return {
      pr: positiveInt(form.get("pr")) ?? query.pr,
      issue: positiveInt(form.get("issue")) ?? query.issue,
      csrf: typeof csrf === "string" ? csrf : undefined,
      token: typeof token === "string" ? token : query.token,
    };
  }
  return query;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 1_000_000_000) return undefined;
  return n;
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
