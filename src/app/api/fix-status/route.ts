import { after, NextResponse } from "next/server";
import { resumeOutstandingFixes } from "@/lib/fix";
import { safeEqual } from "@/lib/github-signature";
import { resumeOutstandingRepros } from "@/lib/repro-track";
import { serverlessTrackBudgetMs } from "@/lib/run-status";

// Hobby Fluid compute allows 300s, including work scheduled with after().
// Node.js is the default runtime; cacheComponents rejects an explicit runtime export.
export const maxDuration = 300;

/**
 * Resume fix runs and reproduction checks that outlived the previous invocation.
 * Vercel Cron GETs this daily (Hobby allows one run per day) with
 * `Authorization: Bearer $CRON_SECRET`. A slice that is still pending POSTs
 * the same URL so tracking continues immediately.
 * The body of work runs in after() so a caller is not held for the slice.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  if (!safeEqual(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const issueParam = new URL(req.url).searchParams.get("issue");
  const issue = issueParam ? Number(issueParam) : undefined;
  if (issueParam && (!issue || !Number.isInteger(issue))) {
    return NextResponse.json({ error: "Invalid issue" }, { status: 400 });
  }

  const budgetMs = serverlessTrackBudgetMs();
  after(async () => {
    try {
      const fixes = await resumeOutstandingFixes({ issue, budgetMs });
      const repros = await resumeOutstandingRepros({ issue, budgetMs });
      console.log("[fix-status]", JSON.stringify({ fixes, repros }));
    } catch (err) {
      console.error("[fix-status] failed", err);
    }
  });

  return NextResponse.json({ ok: true, accepted: true });
}

export const GET = handle;
export const POST = handle;
