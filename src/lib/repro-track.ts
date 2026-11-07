import { continueTracking } from "./fix";
import * as gh from "./github";
import { requestReview } from "./notify";
import { recordOpenedCase } from "./quality-audit";
import { appendCaseMarker, asDelivery, qualityCase, type NotifyDelivery, type QualityCase } from "./quality-case";
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
  quality?: PendingRepro["quality"];
  triageAgentId?: string;
  triageRunId?: string;
  intakeDelivery?: NotifyDelivery;
  intakeAt?: string;
  triageAt?: string;
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
      ...(report.quality ? { quality: report.quality } : {}),
      ...(report.triageAgentId ? { triageAgentId: report.triageAgentId } : {}),
      ...(report.triageRunId ? { triageRunId: report.triageRunId } : {}),
      ...(report.intakeDelivery ? { intakeDelivery: report.intakeDelivery } : {}),
      ...(report.intakeAt ? { intakeAt: report.intakeAt } : {}),
      ...(report.triageAt ? { triageAt: report.triageAt } : {}),
    };
    const issue = await gh.createIssue(report.title, pendingIssueBody(pending), [gh.LABEL_REPRO_PENDING]);
    await bindCase(issue.number, pendingIssueBody(pending), carried(report));
    console.log(`[feedback] reproduction check pending #${issue.number}`);
    await writeCase(issue.number, report, {
      status: "pending",
      testPath: verdict.testPath,
      branch: verdict.branch,
      sha: verdict.sha,
    });
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
    const issue = await save(existing, report.title, body, [gh.FEEDBACK_LABEL, gh.LABEL_AWAITING], carried(report));
    console.log(`[feedback] created #${issue.number}`);
    let reviewDelivery: NotifyDelivery = "failed";
    try {
      const sent = await requestReview({
        number: issue.number,
        title: report.title,
        url: issue.url,
        summary: report.summary,
        ...(carried(report) ? { quality: carried(report) } : {}),
      });
      reviewDelivery = asDelivery(sent?.delivery);
    } catch (error) {
      console.error("[notify] review_request failed", error instanceof Error ? error.name : "Error");
      await writeCase(issue.number, report, verdict, "failed");
      throw error;
    }
    await writeCase(issue.number, report, verdict, reviewDelivery);
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
  const issue = await save(
    existing,
    report.title,
    body,
    [gh.FEEDBACK_LABEL, gh.LABEL_CANNOT_REPRODUCE],
    carried(report),
  );
  await gh.closeIssue(issue.number);
  await writeCase(issue.number, report, verdict);
  console.log(`[feedback] cannot reproduce #${issue.number} (${verdict.status})`);
}

function carried(report: Report): QualityCase | undefined {
  if (!report.quality) return undefined;
  return qualityCase({
    caseId: report.quality.caseId,
    severity: report.quality.severity,
    reason: report.quality.reason,
    category: report.quality.category,
  });
}

async function writeCase(
  issue: number,
  report: Report,
  verdict: ReproduceResult,
  reviewDelivery?: NotifyDelivery,
): Promise<void> {
  const quality = carried(report);
  if (!quality) return;
  const repro = verdict.status === "reproduced"
    ? "reproduced"
    : verdict.status === "pending"
      ? "pending"
      : verdict.status === "error"
        ? "error"
        : "not_reproduced";
  await recordOpenedCase({
    issue,
    quality,
    triageAgentId: report.triageAgentId,
    triageRunId: report.triageRunId,
    branch: "branch" in verdict ? verdict.branch : undefined,
    testPath: "testPath" in verdict ? verdict.testPath : undefined,
    sha: "sha" in verdict ? verdict.sha : undefined,
    checkUrl: "checkUrl" in verdict ? verdict.checkUrl : undefined,
    intakeDelivery: report.intakeDelivery ?? "skipped",
    intakeAt: report.intakeAt,
    triageAt: report.triageAt,
    repro,
    reproError: verdict.status === "error" ? verdict.detail : undefined,
    reviewDelivery,
  });
}

async function save(
  existing: { number: number; url: string } | undefined,
  title: string,
  body: string,
  labels: string[],
  quality?: QualityCase,
): Promise<{ number: number; url: string }> {
  if (!existing) {
    const created = labels.includes(gh.LABEL_AWAITING)
      ? await gh.createIssue(title, body)
      : await gh.createIssue(title, body, labels);
    await bindCase(created.number, body, quality);
    return created;
  }
  await gh.updateIssue(existing.number, quality ? appendCaseMarker(body, quality, existing.number) : body);
  await gh.setLabels(existing.number, labels);
  return existing;
}

async function bindCase(issue: number, body: string, quality: QualityCase | undefined): Promise<void> {
  if (!quality) return;
  try {
    await gh.updateIssue(issue, appendCaseMarker(body, quality, issue));
  } catch (error) {
    console.error(`[quality] case_marker_failed issue=${issue} case=${quality.caseId} error=github_write_failed name=${error instanceof Error ? error.name : "Error"}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
