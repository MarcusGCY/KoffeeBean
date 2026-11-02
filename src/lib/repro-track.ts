import { continueTracking } from "./fix";
import * as gh from "./github";
import { requestReview } from "./notify";
import {
  cannotReproduceBody,
  judgeRepro,
  pendingIssueBody,
  parsePending,
  reproducedIssueBody,
  type PendingRepro,
  type ReproduceResult,
} from "./reproduce";
import { POLL_CAP_MS, POLL_INTERVAL_MS, serverlessTrackBudgetMs } from "./run-status";

type Report = {
  title: string;
  summary: string;
  feedback: string;
  reportedBy: string;
};

export type ReproResume =
  | { action: "skipped"; reason: string }
  | { action: "pending" }
  | { action: "completed"; status: ReproduceResult["status"] }
  | { action: "deferred" };

/**
 * One Checks API read, then poll until `budgetMs` when the check is still
 * running. Vercel passes 0 from the feedback request (triage already used
 * the slice) and the serverless budget from `/api/fix-status`.
 */
export async function watchRepro(
  testPath: string | undefined,
  branch: string | undefined,
  budgetMs: number,
  opts?: { sha?: string; dispatch?: boolean },
): Promise<ReproduceResult> {
  const deadline = Date.now() + Math.max(0, budgetMs);
  let sha = opts?.sha;
  let dispatch = opts?.dispatch ?? false;
  let verdict = await judgeRepro(testPath, branch, { sha, dispatch });
  if ("sha" in verdict && verdict.sha) sha = verdict.sha;
  dispatch = false;
  while (verdict.status === "pending" && Date.now() < deadline) {
    const wait = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
    if (wait < 500) break;
    await delay(wait);
    verdict = await judgeRepro(testPath, branch, { sha, dispatch });
    if ("sha" in verdict && verdict.sha) sha = verdict.sha;
  }
  return verdict;
}

/** Local dev waits the check out. On Vercel a pending check is handed off. */
export function initialReproBudgetMs(): number {
  return process.env.VERCEL === "1" ? 0 : POLL_CAP_MS;
}

export async function settleNewReport(
  report: Report & { testPath?: string; branch?: string },
): Promise<void> {
  const verdict = await watchRepro(report.testPath, report.branch, initialReproBudgetMs(), { dispatch: true });
  if (verdict.status === "pending") {
    await gh.ensureLabel(gh.LABEL_REPRO_PENDING, "fbca04", "Reproduction check has not finished");
    const pending: PendingRepro = {
      title: report.title,
      summary: report.summary,
      feedback: report.feedback,
      reportedBy: report.reportedBy,
      testPath: verdict.testPath,
      branch: verdict.branch,
      sha: verdict.sha,
      startedAt: Date.now(),
    };
    const issue = await gh.createIssue(report.title, pendingIssueBody(pending), [gh.LABEL_REPRO_PENDING]);
    console.log(`[feedback] reproduction check pending #${issue.number}`);
    await continueTracking(issue.number);
    return;
  }
  await publish(undefined, report, verdict);
}

/** Continue a reproduction check saved on a `repro-pending` issue. */
export async function resumeRepro(number: number, budgetMs: number): Promise<ReproResume> {
  const issue = await gh.getIssue(number);
  if (!issue.labels.includes(gh.LABEL_REPRO_PENDING)) return { action: "skipped", reason: "not-pending" };
  const pending = parsePending(issue.body);
  if (!pending) return { action: "skipped", reason: "no-marker" };

  const verdict = await watchRepro(pending.testPath, pending.branch, budgetMs, {
    sha: pending.sha,
    dispatch: false,
  });
  if (verdict.status === "pending") {
    if (Date.now() - pending.startedAt >= POLL_CAP_MS) {
      await publish(issue, pending, {
        status: "error",
        testPath: pending.testPath,
        branch: pending.branch,
        detail: "The reproduction check did not finish within 30 minutes.",
      });
      return { action: "completed", status: "error" };
    }
    await continueTracking(number);
    return { action: "pending" };
  }

  const current = await gh.getIssue(number);
  if (!current.labels.includes(gh.LABEL_REPRO_PENDING)) return { action: "skipped", reason: "not-pending" };
  await publish(current, pending, verdict);
  return { action: "completed", status: verdict.status };
}

/**
 * Same entry as fix tracking: one issue from the chained POST, or every
 * open `repro-pending` issue from cron.
 */
export async function resumeOutstandingRepros(opts?: { issue?: number; budgetMs?: number }) {
  const numbers = opts?.issue != null ? [opts.issue] : await gh.listReproPendingIssueNumbers();
  const budget = opts?.budgetMs ?? serverlessTrackBudgetMs();
  const deadline = Date.now() + budget;
  const results: ({ number: number } & ReproResume)[] = [];
  for (const number of numbers) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      await continueTracking(number);
      results.push({ number, action: "deferred" });
      continue;
    }
    results.push({ number, ...(await resumeRepro(number, remaining)) });
  }
  return results;
}

async function publish(
  existing: { number: number; url: string } | undefined,
  report: Report,
  verdict: ReproduceResult,
): Promise<void> {
  if (verdict.status === "pending") return;
  if (verdict.status === "reproduced") {
    const body = reproducedIssueBody({
      summary: report.summary,
      testPath: verdict.testPath,
      branch: verdict.branch,
      sha: verdict.sha,
      output: verdict.output,
      checkUrl: verdict.checkUrl,
      feedback: report.feedback,
      reportedBy: report.reportedBy,
    });
    const issue = await save(existing, report.title, body, [gh.FEEDBACK_LABEL, gh.LABEL_AWAITING]);
    console.log(`[feedback] created #${issue.number}`);
    await requestReview({
      number: issue.number,
      title: report.title,
      url: issue.url,
      summary: report.summary,
    });
    return;
  }

  await gh.ensureLabel(
    gh.LABEL_CANNOT_REPRODUCE,
    "ededed",
    "Triage could not reproduce this report on main",
  );
  const body = cannotReproduceBody({
    summary: report.summary,
    feedback: report.feedback,
    reportedBy: report.reportedBy,
    reason: verdict.status === "passed" ? "passed" : verdict.status === "error" ? "error" : "no-test",
    detail: verdict.status === "error" ? verdict.detail : undefined,
    testPath: "testPath" in verdict ? verdict.testPath : undefined,
    branch: "branch" in verdict ? verdict.branch : undefined,
    checkUrl: "checkUrl" in verdict ? verdict.checkUrl : undefined,
  });
  const issue = await save(existing, report.title, body, [gh.FEEDBACK_LABEL, gh.LABEL_CANNOT_REPRODUCE]);
  await gh.closeIssue(issue.number);
  console.log(`[feedback] cannot reproduce #${issue.number} (${verdict.status})`);
}

async function save(
  existing: { number: number; url: string } | undefined,
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string }> {
  if (!existing) {
    if (labels.includes(gh.LABEL_AWAITING)) return gh.createIssue(title, body);
    return gh.createIssue(title, body, labels);
  }
  await gh.updateIssue(existing.number, body);
  await gh.setLabels(existing.number, labels);
  return existing;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
