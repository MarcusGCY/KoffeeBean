import { after, NextResponse } from "next/server";
import { repo } from "@/lib/env";
import { resumeFix } from "@/lib/fix";
import { verifyGithubSignature } from "@/lib/github-signature";
import { wakesForPullRequest } from "@/lib/pull-request";
import { serverlessTrackBudgetMs } from "@/lib/run-status";

// Hobby Fluid compute allows 300s, including work scheduled with after().
// Node.js is the default runtime; cacheComponents rejects an explicit runtime export.
export const maxDuration = 300;

const PULL_ACTIONS = new Set(["opened", "synchronize", "reopened", "closed"]);

type PullPayload = {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { title?: string | null; body?: string | null; html_url?: string };
};

/**
 * GitHub calls this when a pull request is opened or updated. That is the
 * signal that a cloud agent is far enough along to finish fix_completed,
 * without holding the approve request open for the whole run.
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
  if (event !== "pull_request") return NextResponse.json({ ok: true, ignored: event });

  let payload: PullPayload;
  try {
    payload = JSON.parse(raw) as PullPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = payload.action ?? "";
  if (!PULL_ACTIONS.has(action)) return NextResponse.json({ ok: true, ignored: action });

  const { owner, repo: name } = repo();
  const full = payload.repository?.full_name ?? "";
  if (full.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    return NextResponse.json({ ok: true, ignored: "repo" });
  }

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
