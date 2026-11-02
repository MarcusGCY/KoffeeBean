import { after, NextResponse } from "next/server";
import { repo } from "@/lib/env";
import { resumeFix } from "@/lib/fix";
import { verifyGithubSignature } from "@/lib/github-signature";
import { wakesForPullRequest } from "@/lib/pull-request";
import { resumeOutstandingRepros } from "@/lib/repro-track";
import { REPRO_CHECK } from "@/lib/reproduce";
import { serverlessTrackBudgetMs } from "@/lib/run-status";

// Hobby Fluid compute allows 300s, including work scheduled with after().
// Node.js is the default runtime; cacheComponents rejects an explicit runtime export.
export const maxDuration = 300;

const PULL_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);
type HookPayload = {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { title?: string | null; body?: string | null; html_url?: string };
  check_run?: { name?: string | null };
  workflow?: { path?: string | null; name?: string | null };
  workflow_run?: { name?: string | null; path?: string | null };
};

/**
 * GitHub calls this when a pull request is opened or updated, or when the
 * reproduction workflow finishes. Either event resumes work that was handed
 * off before the function limit, the same way `/api/fix-status` does.
 */
export async function POST(req: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "GITHUB_WEBHOOK_SECRET is not set" }, { status: 503 });
  }
  const raw = await req.text();
  if (!verifyGithubSignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = req.headers.get("x-github-event") ?? "";
  if (event === "ping") return NextResponse.json({ ok: true });
  if (event !== "pull_request" && event !== "check_run" && event !== "workflow_run") {
    return NextResponse.json({ ok: true, ignored: event });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { owner, repo: name } = repo();
  const full = payload.repository?.full_name ?? "";
  if (full.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    return NextResponse.json({ ok: true, ignored: "repo" });
  }

  const action = payload.action ?? "";
  if (event === "check_run" || event === "workflow_run") {
    const checkName = payload.check_run?.name ?? "";
    const workflowPath = payload.workflow?.path ?? payload.workflow_run?.path ?? "";
    const isRepro = event === "check_run"
      ? action === "completed" && checkName === REPRO_CHECK
      : action === "completed" && workflowPath.endsWith("repro.yml");
    if (!isRepro) return NextResponse.json({ ok: true, ignored: action || checkName || workflowPath });
    after(async () => {
      try {
        await resumeOutstandingRepros({ budgetMs: serverlessTrackBudgetMs() });
      } catch (err) {
        console.error("[github-webhook] repro resume failed", err);
      }
    });
    return NextResponse.json({ ok: true });
  }

  if (!PULL_ACTIONS.has(action)) return NextResponse.json({ ok: true, ignored: action });
  const pr = payload.pull_request;
  if (!pr?.html_url) return NextResponse.json({ ok: true, ignored: "no-pr" });
  const title = pr.title ?? "";
  const body = pr.body ?? "";
  const htmlUrl = pr.html_url;

  after(async () => {
    try {
      const wakes = await wakesForPullRequest({ title, body, html_url: htmlUrl });
      const deadline = Date.now() + serverlessTrackBudgetMs();
      for (const wake of wakes) {
        const remaining = deadline - Date.now();
        if (remaining < 1000) break;
        await resumeFix(wake.issue, { prUrl: wake.prUrl, agentId: wake.agentId, budgetMs: remaining });
      }
    } catch (err) {
      console.error("[github-webhook] resume failed", err);
    }
  });

  return NextResponse.json({ ok: true });
}
