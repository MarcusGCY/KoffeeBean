import { repo } from "./env";
import {
  fixMergedComment,
  hasFixMerged,
  recordedFixPull,
} from "./fix-marker";
import * as gh from "./github";
import { notifyFixMerged } from "./notify";

export class MergeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MergeError";
    this.status = status;
  }
}

export type MergeOutcome = {
  status: "merged" | "already-merged";
  message: string;
  issue: number;
  prNumber: number;
  prUrl: string;
  sha?: string;
};

const READY_HINT =
  "GitHub refused to mark the draft ready for review. The fine-grained token needs Pull requests: write (Contents read/write, Pull requests read/write, Issues read/write).";

const MERGE_HINT =
  "GitHub refused to squash-merge. The fine-grained token needs Contents read/write and Pull requests read/write.";

/**
 * Squash-merge the pull request recorded on the issue.
 * An already-merged pull request returns `already-merged` and does not throw.
 */
export async function mergeApprovedFix(issueNumber: number, prNumber: number): Promise<MergeOutcome> {
  const fullName = `${repo().owner}/${repo().repo}`;
  let issue: Awaited<ReturnType<typeof gh.getIssue>>;
  try {
    issue = await gh.getIssue(issueNumber);
  } catch (error) {
    if (gh.githubHttpStatus(error) === 404) throw new MergeError(`Issue #${issueNumber} was not found.`, 404);
    throw error;
  }

  const comments = await gh.listComments(issueNumber);
  const recorded = recordedFixPull(comments.map((c) => c.body), fullName);
  if (!recorded || recorded.prNumber !== prNumber) {
    throw new MergeError(`Pull request #${prNumber} is not the fix recorded for issue #${issueNumber}.`, 409);
  }

  let pull = await loadPull(prNumber);
  assertOwned(pull, fullName);
  assertHead(pull, recorded.head, issueNumber);

  if (!pull.merged) {
    if (pull.state !== "open") {
      throw new MergeError(`Pull request #${prNumber} is closed and was not merged.`, 409);
    }
    if (pull.draft) {
      pull = await markReady(pull);
      assertOwned(pull, fullName);
      assertHead(pull, recorded.head, issueNumber);
      if (pull.merged) return finish(issue, pull, true);
      if (pull.state !== "open") {
        throw new MergeError(`Pull request #${prNumber} is closed and was not merged.`, 409);
      }
    }
    pull = await waitMergeable(pull);
    if (pull.merged) return finish(issue, pull, true);
    if (pull.mergeable === null) {
      throw new MergeError(
        `GitHub is still calculating whether pull request #${prNumber} can be merged. Open the link again in a moment.`,
        409,
      );
    }
    if (pull.mergeable === false) {
      throw new MergeError(
        `Pull request #${prNumber} cannot be merged yet. Resolve conflicts or failing checks, then open the link again.`,
        409,
      );
    }
    try {
      const sha = await gh.squashMergePullRequest(prNumber, commitTitle(pull));
      pull = { ...pull, merged: true, state: "closed", mergeCommitSha: sha };
      return finish(issue, pull, false);
    } catch (error) {
      const again = await gh.getPullRequest(prNumber);
      if (again?.merged) return finish(issue, again, true);
      if (isPermissionError(error)) throw new MergeError(MERGE_HINT, 403);
      throw new MergeError(`Pull request #${prNumber} could not be merged. ${publicMessage(error)}`, 409);
    }
  }

  return finish(issue, pull, true);
}

async function finish(
  issue: { number: number; title: string; url: string },
  pull: gh.PullSnapshot,
  already: boolean,
): Promise<MergeOutcome> {
  const sha = pull.mergeCommitSha;
  const comments = await gh.listComments(issue.number);
  const hadMarker = comments.some((c) => hasFixMerged(c.body));
  if (!hadMarker && sha) {
    await gh.ensureLabel(gh.LABEL_MERGED, "0e8a16", "Fix pull request was squash-merged");
    await gh.setLabels(issue.number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED, gh.LABEL_MERGED]);
    await gh.closeIssue(issue.number);
    await gh.comment(issue.number, fixMergedComment(pull.url, sha));
    await notifyFixMerged({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      prNumber: pull.number,
      prUrl: pull.url,
      sha,
    });
  } else if (!hadMarker && !sha && !already) {
    throw new MergeError("GitHub merged the pull request but did not return a commit sha.", 502);
  }

  const short = sha ? ` (${sha.slice(0, 7)})` : "";
  if (already || hadMarker) {
    return {
      status: "already-merged",
      message: `Pull request #${pull.number} is already merged.`,
      issue: issue.number,
      prNumber: pull.number,
      prUrl: pull.url,
      ...(sha ? { sha } : {}),
    };
  }
  return {
    status: "merged",
    message: `Squash-merged pull request #${pull.number} for issue #${issue.number}${short}. Vercel will redeploy main shortly.`,
    issue: issue.number,
    prNumber: pull.number,
    prUrl: pull.url,
    sha,
  };
}

async function markReady(pull: gh.PullSnapshot): Promise<gh.PullSnapshot> {
  try {
    await gh.markPullRequestReady(pull.nodeId);
  } catch (error) {
    if (!isAlreadyReady(error)) {
      if (isPermissionError(error)) throw new MergeError(READY_HINT, 403);
      throw new MergeError(
        `GitHub could not mark pull request #${pull.number} ready for review. ${publicMessage(error)}`,
        502,
      );
    }
  }
  const next = await loadPull(pull.number);
  if (next.draft) throw new MergeError(READY_HINT, 403);
  return next;
}

async function loadPull(prNumber: number): Promise<gh.PullSnapshot> {
  const pull = await gh.getPullRequest(prNumber);
  if (!pull) throw new MergeError(`Pull request #${prNumber} was not found in this repository.`, 404);
  return pull;
}

async function waitMergeable(pull: gh.PullSnapshot): Promise<gh.PullSnapshot> {
  let current = pull;
  for (let attempt = 0; attempt < 3 && current.mergeable === null && !current.merged; attempt++) {
    await delay(750);
    current = await loadPull(current.number);
  }
  return current;
}

function assertOwned(pull: gh.PullSnapshot, fullName: string) {
  const expected = fullName.toLowerCase();
  if (pull.baseRepo.toLowerCase() !== expected || !pull.headRepo || pull.headRepo.toLowerCase() !== expected) {
    throw new MergeError(`Pull request #${pull.number} does not belong to ${fullName}.`, 409);
  }
}

function assertHead(pull: gh.PullSnapshot, head: string | undefined, issueNumber: number) {
  if (head && pull.headRef !== head) {
    throw new MergeError(`Pull request #${pull.number} is not the fix recorded for issue #${issueNumber}.`, 409);
  }
}

function commitTitle(pull: gh.PullSnapshot): string {
  const suffix = `(#${pull.number})`;
  if (pull.title.includes(suffix)) return pull.title.slice(0, 240);
  const base = pull.title.trim() || `Fix`;
  const room = 240 - suffix.length - 1;
  return `${base.slice(0, Math.max(0, room))} ${suffix}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || !error) return "";
  const record = error as {
    message?: unknown;
    errors?: { message?: unknown; type?: unknown }[];
    response?: { data?: { message?: unknown; errors?: { message?: unknown }[] } };
  };
  const parts: string[] = [];
  if (typeof record.message === "string") parts.push(record.message);
  for (const item of record.errors ?? []) {
    if (typeof item?.message === "string") parts.push(item.message);
    if (typeof item?.type === "string") parts.push(item.type);
  }
  const data = record.response?.data;
  if (typeof data?.message === "string") parts.push(data.message);
  for (const item of data?.errors ?? []) {
    if (typeof item?.message === "string") parts.push(item.message);
  }
  return parts.join(" ");
}

function isPermissionError(error: unknown): boolean {
  const text = errorText(error);
  if (/resource not accessible|not accessible by|insufficient/i.test(text)) return true;
  const status = gh.githubHttpStatus(error);
  if (status === 401) return true;
  if (status === 403 && !/rate limit|secondary rate|abuse detection/i.test(text)) return true;
  return false;
}

function isAlreadyReady(error: unknown): boolean {
  return /not a draft|already ready|already marked as ready/i.test(errorText(error));
}

function publicMessage(error: unknown): string {
  let message = errorText(error) || (error instanceof Error ? error.message : "GitHub request failed");
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length > 0 && message.includes(token)) {
    message = message.split(token).join("[redacted]");
  }
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.slice(0, 300) || "GitHub request failed";
}
