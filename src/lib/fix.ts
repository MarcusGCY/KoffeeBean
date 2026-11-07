import { Agent, type ModelSelection, type Run, type RunResult } from "@cursor/sdk";
import { resolveCursorModel } from "./agent-model";
import { env, repo } from "./env";
import {
  BEANBOX_ISSUE_METADATA,
  fixResultComment,
  fixRunComment,
  hasFixResult,
  parseFixRun,
  type FixRunRef,
} from "./fix-marker";
import * as gh from "./github";
import { prNumberFromUrl } from "./merge-link";
import {
  appendIdentityLines,
  branchHasIssueToken,
  canonicalPrTitle,
  identityLines,
  issueToken,
  suggestedFixBranch,
} from "./quality-identity";
import { notifyFixCompleted, notifyFixStarted } from "./notify";
import { recordQualityEvent, caseFields } from "./quality-audit";
import { asDelivery, buildEvent, deliveryAck, parseCase } from "./quality-case";
import { appOrigin } from "./origin";
import {
  describeRunError,
  followRun,
  POLL_CAP_MS,
  reconcileRunResult,
  serverlessTrackBudgetMs,
  trackingTimedOutResult,
  type FollowOutcome,
} from "./run-status";

type IssueRef = { number: number; title: string; url: string };

// Fix is rare, runs only after approval and is correctness-critical, so it uses a stronger model.
const FIX_MODEL: ModelSelection = {
  id: "claude-sonnet-5-5",
  params: [
    { id: "reasoning_effort", value: "high" },
    { id: "context", value: "300k" },
  ],
};

/**
 * Launch a Cursor cloud agent that fixes the issue and opens a PR.
 *
 * Locally, this waits until the run finishes (up to 30 minutes). On Vercel
 * the function is killed at maxDuration, so the run id is saved on the issue
 * and a later request (the next slice, the pull_request webhook, or
 * /api/fix-status) publishes the comment and fix_completed webhook.
 */
export async function fixIssue(number: number) {
  const issue = await gh.getIssue(number);
  await gh.setLabels(number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED, gh.LABEL_FIXING]);

  const apiKey = env("CURSOR_API_KEY");
  const startedAt = Date.now();
  const model = await resolveCursorModel({
    kind: "fix",
    envName: "FIX_MODEL",
    fallback: FIX_MODEL,
    apiKey,
  });
  const agent = await Agent.create({
    apiKey,
    model,
    name: `beanbox-fix-#${number}`,
    cloud: {
      repos: [{ url: repo().url }],
      autoCreatePR: true,
      metadata: { [BEANBOX_ISSUE_METADATA]: String(number) },
    },
  });
  try {
    const token = issueToken(number);
    const example = suggestedFixBranch(number, "slug");
    const linked = parseCase(issue.body, number);
    const run = await agent.send(
      [
        `Fix GitHub issue #${number}: ${issue.title}`,
        `Canonical identity: Issue #${number}`,
        issue.url,
        token ? `Machine token: ${token}` : "",
        linked?.caseId ? `Secondary case id: ${linked.caseId}` : "",
        `The git branch must contain ${token ?? "the issue token"}. Example: ${example ?? `cursor/issue-${number}-slug`}.`,
        `The pull request title must start with "Issue #${number}: ".`,
        `The pull request body must include ${issue.url} and Fixes #${number}.`,
        "",
        issue.body,
        "",
        "Follow .cursor/rules/fix.mdc. Hard rules: copy the repro test into the PR and make it pass; never skip or weaken it (no .skip or .todo); do not edit tests/repro beyond that copy.",
        linked?.caseId
          ? `Copy the repro file that already contains case token ${linked.caseId}. Do not rename it.`
          : "Do not rename tests/repro. That file was created before this issue number existed.",
        "Use the minimal-fix and pre-pr-self-check skills (.cursor/skills/minimal-fix/SKILL.md and .cursor/skills/pre-pr-self-check/SKILL.md).",
        `Reference "Fixes #${number}" in the PR description.`,
      ].filter((line) => line !== "").join("\n"),
    );
    console.log(`[fix] agent=${agent.agentId} run=${run.id}`);
    const ref: FixRunRef = { agentId: agent.agentId, runId: run.id, startedAt };
    try {
      await gh.comment(number, fixRunComment(ref));
    } catch (err) {
      console.error(`[fix] could not persist run id on #${number}`, err);
    }
    try {
      await recordLaunch(issue, ref);
    } catch (err) {
      console.error("[fix] launch notice failed", err instanceof Error ? err.name : "Error");
    }

    const outcome = await trackFixRun(run, apiKey);
    if (!outcome.done) {
      console.log(
        `[fix] #${number} still ${outcome.lastStatus ?? "running"}; handing off before the function limit`,
      );
      const handed = await finishIfExpired(issue, ref, outcome);
      if (handed.action === "pending") {
        return { status: "running" as const, prUrl: undefined, pending: true as const };
      }
      return { status: handed.status, prUrl: handed.prUrl };
    }
    const published = await publishFixResult(issue, outcome.result);
    return { status: published.status, prUrl: published.prUrl };
  } finally {
    agent.close();
  }
}

export type ResumeOutcome =
  | { action: "skipped"; reason: string }
  | { action: "pending" }
  | { action: "completed"; status: string; prUrl?: string };

/** Continue a fix that was launched earlier. Safe to call more than once. */
export async function resumeFix(
  number: number,
  opts?: { prUrl?: string; agentId?: string; budgetMs?: number },
): Promise<ResumeOutcome> {
  const issue = await gh.getIssue(number);
  if (!issue.labels.includes(gh.LABEL_FIXING)) return { action: "skipped", reason: "not-fixing" };
  const comments = await gh.listComments(number);
  if (comments.some((c) => hasFixResult(c.body))) return { action: "skipped", reason: "already-reported" };

  const apiKey = env("CURSOR_API_KEY");
  let ref = comments.map((c) => parseFixRun(c.body)).find((parsed): parsed is FixRunRef => Boolean(parsed));
  if (!ref && opts?.agentId) ref = await refFromAgent(opts.agentId, apiKey);
  if (!ref) return { action: "skipped", reason: "no-run" };

  if (Date.now() - ref.startedAt >= POLL_CAP_MS) {
    const published = await publishFixResult(issue, attachPr(trackingTimedOutResult({ id: ref.runId }), opts?.prUrl));
    return { action: "completed", status: published.status, prUrl: published.prUrl };
  }

  const budget = Math.min(
    opts?.budgetMs ?? serverlessTrackBudgetMs(),
    Math.max(0, POLL_CAP_MS - (Date.now() - ref.startedAt)),
  );
  const outcome = await followRun({ id: ref.runId, agentId: ref.agentId }, apiKey, budget);
  if (!outcome.done) return finishIfExpired(issue, ref, outcome, opts?.prUrl);
  const published = await publishFixResult(issue, attachPr(outcome.result, opts?.prUrl));
  return { action: "completed", status: published.status, prUrl: published.prUrl };
}

/** Check every still-fixing issue, or one issue when `issue` is set. */
export async function resumeOutstandingFixes(opts?: { issue?: number; budgetMs?: number }) {
  const numbers = opts?.issue != null ? [opts.issue] : await gh.listFixingIssueNumbers();
  const budget = opts?.budgetMs ?? serverlessTrackBudgetMs();
  const deadline = Date.now() + budget;
  const results: ({ number: number } & (ResumeOutcome | { action: "deferred" }))[] = [];
  for (const number of numbers) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
      await continueTracking(number);
      results.push({ number, action: "deferred" });
      continue;
    }
    results.push({ number, ...(await resumeFix(number, { budgetMs: remaining })) });
  }
  return results;
}

function onVercel(): boolean {
  return process.env.VERCEL === "1";
}

async function trackFixRun(run: Run, apiKey: string): Promise<FollowOutcome> {
  if (onVercel()) return followRun(run, apiKey, serverlessTrackBudgetMs());
  return { done: true, result: await reconcileRunResult(run, apiKey), run };
}

async function finishIfExpired(
  issue: IssueRef,
  ref: FixRunRef,
  outcome: Extract<FollowOutcome, { done: false }>,
  prUrl?: string,
): Promise<Extract<ResumeOutcome, { action: "pending" | "completed" }>> {
  if (Date.now() - ref.startedAt < POLL_CAP_MS - 500) {
    await continueTracking(issue.number);
    return { action: "pending" };
  }
  const published = await publishFixResult(
    issue,
    attachPr(trackingTimedOutResult({ id: ref.runId }, outcome.last, outcome.lastFailure), prUrl),
  );
  return { action: "completed", status: published.status, prUrl: published.prUrl };
}

async function refFromAgent(agentId: string, apiKey: string): Promise<FixRunRef | undefined> {
  try {
    const listed = await Agent.listRuns(agentId, { runtime: "cloud", apiKey });
    const latest = [...listed.items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!latest) return undefined;
    return { agentId, runId: latest.id, startedAt: latest.createdAt ?? Date.now() };
  } catch (err) {
    console.error(`[fix] could not list runs for ${agentId}`, err);
    return undefined;
  }
}

async function publishFixResult(
  issue: IssueRef,
  result: RunResult,
): Promise<{ status: string; prUrl?: string; skipped: boolean }> {
  const pr = prOf(result);
  const current = await gh.getIssue(issue.number);
  const comments = await gh.listComments(issue.number);
  if (!current.labels.includes(gh.LABEL_FIXING) || comments.some((c) => hasFixResult(c.body))) {
    console.log(`[fix] #${issue.number} already reported; skipping`);
    return { status: result.status, prUrl: pr, skipped: true };
  }
  const summary = fixSummary(result, pr);
  const fullName = `${repo().owner}/${repo().repo}`;
  const meta = pr
    ? { prUrl: pr, prNumber: prNumberFromUrl(pr, fullName), head: headOf(result) }
    : undefined;
  await gh.comment(issue.number, fixResultComment(summary, meta));
  await gh.setLabels(issue.number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED]);
  const quality = parseCase(current.body, issue.number);
  const run = comments.map((comment) => parseFixRun(comment.body)).find((parsed): parsed is FixRunRef => Boolean(parsed));
  const named = await alignPullIdentity(meta?.prNumber, issue.number, issue.title, headOf(result), quality?.caseId, issue.url);
  const delivery = asDelivery(await notifyFixCompleted({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    status: result.status,
    prUrl: pr,
    summary,
    quality,
    agentId: run?.agentId,
    runId: run?.runId,
    headSha: named.headSha,
    branch: named.branch,
    branchHasIssueToken: named.branchHasIssueToken,
    prTitle: named.title,
    alignment: named.alignment,
    alignmentError: named.alignmentError,
    titleNonconformance: named.titleNonconformance,
  }));
  const at = new Date().toISOString();
  const fields = caseFields(quality);
  await recordQualityEvent(issue.number, buildEvent({
    actionId: `fix_result:${issue.number}:${meta?.prNumber ?? result.status}`,
    ...fields,
    stage: "fix_result",
    status: pr ? "opened" : "error",
    at,
    actor: "cursor_agent",
    issue: issue.number,
    pr: meta?.prNumber ?? null,
    agentId: run?.agentId ?? null,
    runId: run?.runId ?? null,
    evidence: pr ? "pull request recorded; test report is not verification" : "no pull request",
    attempt: 1,
    nextOwner: pr ? "verification" : "app",
    blocker: pr ? "independent verification not acknowledged; pull request test report is not verification" : "no pull request was opened",
    externalAck: "none",
  }));
  await recordQualityEvent(issue.number, buildEvent({
    actionId: `notify_fix_completed:${issue.number}:${meta?.prNumber ?? result.status}`,
    ...fields,
    stage: "notify_fix_completed",
    status: delivery === "failed" ? "undelivered" : delivery,
    at,
    actor: "app",
    issue: issue.number,
    pr: meta?.prNumber ?? null,
    agentId: run?.agentId ?? null,
    runId: run?.runId ?? null,
    evidence: `fix_completed ${delivery}`,
    error: delivery === "failed" ? "webhook_failed" : null,
    attempt: 1,
    nextOwner: "verification",
    blocker: "independent verification not acknowledged; room display is not observed",
    externalAck: deliveryAck(delivery),
  }));
  return { status: result.status, prUrl: pr, skipped: false };
}

type PullAlignment = {
  title?: string;
  headSha?: string;
  branch?: string;
  branchHasIssueToken: boolean;
  alignment: "updated" | "unchanged" | "failed" | "skipped";
  alignmentError?: "github_read_failed" | "github_write_failed";
  titleNonconformance: boolean;
};

async function alignPullIdentity(
  prNumber: number | undefined,
  issueNumber: number,
  fallbackTitle: string,
  reportedBranch: string | undefined,
  caseId: string | undefined,
  issueUrl: string,
): Promise<PullAlignment> {
  const wanted = canonicalPrTitle(issueNumber, fallbackTitle);
  const lines = identityLines({ issue: issueNumber, caseId, url: issueUrl });
  if (!prNumber) {
    return {
      branch: reportedBranch,
      branchHasIssueToken: branchHasIssueToken(reportedBranch, issueNumber),
      alignment: "skipped",
      titleNonconformance: false,
    };
  }
  let pull: Awaited<ReturnType<typeof gh.getPullRequest>>;
  try {
    pull = await gh.getPullRequest(prNumber);
  } catch (error) {
    console.error(`[quality] title_read_failed issue=${issueNumber} pr=${prNumber} error=github_read_failed name=${error instanceof Error ? error.name : "Error"}`);
    return {
      branch: reportedBranch,
      branchHasIssueToken: branchHasIssueToken(reportedBranch, issueNumber),
      alignment: "failed",
      alignmentError: "github_read_failed",
      titleNonconformance: true,
    };
  }
  if (!pull) {
    return {
      branch: reportedBranch,
      branchHasIssueToken: branchHasIssueToken(reportedBranch, issueNumber),
      alignment: "failed",
      alignmentError: "github_read_failed",
      titleNonconformance: true,
    };
  }
  const observed = pull.title ?? "";
  const branch = pull.headRef || reportedBranch;
  const nextBody = appendIdentityLines(pull.body ?? "", lines);
  const patch: { title?: string; body?: string } = {};
  if (observed !== wanted) patch.title = wanted;
  // Sending body replaces it. Skip that write when every identity line is already present.
  if (nextBody !== (pull.body ?? "")) patch.body = nextBody;
  if (!patch.title && !patch.body) {
    return {
      title: observed,
      headSha: pull.headSha,
      branch,
      branchHasIssueToken: branchHasIssueToken(branch, issueNumber),
      alignment: "unchanged",
      titleNonconformance: false,
    };
  }
  try {
    await gh.updatePull(prNumber, patch);
  } catch (error) {
    console.error(`[quality] title_write_failed issue=${issueNumber} pr=${prNumber} error=github_write_failed name=${error instanceof Error ? error.name : "Error"}`);
    return {
      title: observed,
      headSha: pull.headSha,
      branch,
      branchHasIssueToken: branchHasIssueToken(branch, issueNumber),
      alignment: "failed",
      alignmentError: "github_write_failed",
      titleNonconformance: observed !== wanted,
    };
  }
  return {
    title: patch.title ?? observed,
    headSha: pull.headSha,
    branch,
    branchHasIssueToken: branchHasIssueToken(branch, issueNumber),
    alignment: "updated",
    titleNonconformance: false,
  };
}

async function recordLaunch(issue: IssueRef, ref: FixRunRef): Promise<void> {
  const current = await gh.getIssue(issue.number);
  const quality = parseCase(current.body, issue.number);
  const fields = caseFields(quality);
  const at = new Date().toISOString();
  await recordQualityEvent(issue.number, buildEvent({
    actionId: `fix_launch:${issue.number}:${ref.runId}`,
    ...fields,
    stage: "fix_launch",
    status: "launched",
    at,
    actor: "cursor_agent",
    issue: issue.number,
    pr: null,
    agentId: ref.agentId,
    runId: ref.runId,
    evidence: "app launched the only fix",
    attempt: 1,
    nextOwner: "engineering",
    blocker: "adoption not acknowledged; do not launch another fix",
    externalAck: "none",
  }));
  const delivery = asDelivery(await notifyFixStarted({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    quality,
    agentId: ref.agentId,
    runId: ref.runId,
  }));
  await recordQualityEvent(issue.number, buildEvent({
    actionId: `notify_fix_started:${issue.number}:${ref.runId}`,
    ...fields,
    stage: "notify_fix_started",
    status: delivery === "failed" ? "undelivered" : delivery,
    at,
    actor: "app",
    issue: issue.number,
    pr: null,
    agentId: ref.agentId,
    runId: ref.runId,
    evidence: `fix_started ${delivery}`,
    error: delivery === "failed" ? "webhook_failed" : null,
    attempt: 1,
    nextOwner: "engineering",
    blocker: "adoption not acknowledged; room display is not observed",
    externalAck: deliveryAck(delivery),
  }));
}

/**
 * The PR URL is git metadata on the getRun snapshot, not the assistant
 * transcript. `fix_completed` uses this URL plus the status sentence in
 * `fixSummary`. A missing `result` string does not change that payload.
 */
function prOf(result: RunResult): string | undefined {
  return result.git?.branches.find((b) => b.prUrl)?.prUrl;
}

/** Head branch the Cursor run reported for the pull request, without refs/heads/. */
function headOf(result: RunResult): string | undefined {
  const branches = result.git?.branches ?? [];
  const named = branches.find((b) => b.prUrl && b.branch?.trim()) ?? branches.find((b) => b.branch?.trim());
  const name = named?.branch?.trim();
  if (!name) return undefined;
  return name.replace(/^refs\/heads\//, "");
}

function attachPr(result: RunResult, prUrl: string | undefined): RunResult {
  if (!prUrl || prOf(result)) return result;
  const branches = result.git?.branches ?? [];
  return { ...result, git: { branches: [...branches, { repoUrl: repo().url, prUrl }] } };
}

/**
 * Ask this deployment to keep polling. The next request returns immediately
 * and continues in `after()`, so this call does not stack function time.
 * No-op off Vercel, or when CRON_SECRET / the public origin is missing.
 * Fixes and pending reproduction checks both resume from `/api/fix-status`.
 */
export async function continueTracking(number: number): Promise<void> {
  if (!onVercel()) return;
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn(
      `[fix] #${number} still running; set CRON_SECRET so tracking continues. The pull_request or check_run webhook can also finish it.`,
    );
    return;
  }
  let origin: string;
  try {
    origin = appOrigin();
  } catch {
    console.warn(`[fix] #${number} still running; no public origin to continue tracking`);
    return;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers["x-vercel-protection-bypass"] = bypass;
  try {
    const res = await fetch(`${origin}/api/fix-status?issue=${number}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    console.log(`[fix] continued tracking #${number} -> ${res.status}`);
  } catch (err) {
    console.error(`[fix] could not continue tracking #${number}`, err);
  }
}

function fixSummary(result: RunResult, pr: string | undefined): string {
  if (result.status === "finished" && pr) return `Cursor opened a fix: ${pr}`;
  const detail = result.status === "finished" ? undefined : describeRunError(result.error);
  return `Cursor run ended with status \`${result.status}\`.${detail ? ` ${detail}.` : ""} ${pr ?? "No PR was created."}`;
}
