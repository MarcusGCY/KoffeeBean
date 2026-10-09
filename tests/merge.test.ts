import { beforeEach, describe, expect, it, vi } from "vitest";

const getIssue = vi.hoisted(() => vi.fn());
const listComments = vi.hoisted(() => vi.fn());
const getPullRequest = vi.hoisted(() => vi.fn());
const markPullRequestReady = vi.hoisted(() => vi.fn());
const squashMergePullRequest = vi.hoisted(() => vi.fn());
const comment = vi.hoisted(() => vi.fn());
const setLabels = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const notifyFixMerged = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    getIssue,
    listComments,
    getPullRequest,
    markPullRequestReady,
    squashMergePullRequest,
    comment,
    setLabels,
    closeIssue,
    ensureLabel,
  };
});

vi.mock("@/lib/notify", () => ({
  notifyFixMerged,
}));

import { GET } from "@/app/api/merge/route";
import { fixMergedComment, fixResultComment } from "@/lib/fix-marker";
import { mergeApprovedFix } from "@/lib/merge";
import { MERGE_LINK_TTL_MS, mergeToken } from "@/lib/merge-link";

const SHA = "a".repeat(40);
const PR_URL = "https://github.com/acme/beanbox/pull/15";
const HEAD = "cursor/beanbox-fix-14";

const issue = {
  number: 14,
  title: "Bean images not loading",
  body: "Photos 404",
  url: "https://github.com/acme/beanbox/issues/14",
  state: "open",
  labels: ["user-feedback", "approved"],
};

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 15,
    nodeId: "PR_kwDO",
    title: "Fix coffee bean images",
    url: PR_URL,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headRef: HEAD,
    headRepo: "acme/beanbox",
    baseRepo: "acme/beanbox",
    mergeCommitSha: undefined as string | undefined,
    ...overrides,
  };
}

const comments: { id: number; body: string }[] = [];

function resultComment() {
  return fixResultComment(`Cursor opened a fix: ${PR_URL}`, {
    prUrl: PR_URL,
    prNumber: 15,
    head: HEAD,
  });
}

beforeEach(() => {
  getIssue.mockReset();
  listComments.mockReset();
  getPullRequest.mockReset();
  markPullRequestReady.mockReset();
  squashMergePullRequest.mockReset();
  comment.mockReset();
  setLabels.mockReset();
  closeIssue.mockReset();
  ensureLabel.mockReset();
  notifyFixMerged.mockReset();
  comments.length = 0;
  comments.push({ id: 1, body: resultComment() });
  process.env.APPROVAL_SECRET = "test-secret";
  process.env.APP_URL = "http://localhost:3000";
  process.env.GITHUB_REPO = "acme/beanbox";
  process.env.GITHUB_TOKEN = "ghp_test";
  getIssue.mockResolvedValue({ ...issue });
  listComments.mockImplementation(async () => comments.map((c) => ({ ...c })));
  comment.mockImplementation(async (_n: number, body: string) => {
    comments.push({ id: comments.length + 1, body });
  });
  ensureLabel.mockResolvedValue(undefined);
  setLabels.mockResolvedValue(undefined);
  closeIssue.mockResolvedValue(undefined);
  markPullRequestReady.mockResolvedValue(undefined);
  notifyFixMerged.mockResolvedValue(undefined);
  squashMergePullRequest.mockResolvedValue(SHA);
  getPullRequest.mockResolvedValue(pull());
});

function mergeRequest(pr = 15, token = mergeToken(14, pr)) {
  return new Request(`http://localhost:3000/api/merge?issue=14&pr=${pr}&token=${encodeURIComponent(token)}`);
}

describe("mergeApprovedFix", () => {
  it("squash-merges a ready pull request, closes the issue, and notifies the bot", async () => {
    const outcome = await mergeApprovedFix(14, 15);

    expect(outcome).toMatchObject({
      status: "merged",
      issue: 14,
      prNumber: 15,
      prUrl: PR_URL,
      sha: SHA,
    });
    expect(outcome.message).toContain("Vercel will redeploy main shortly");
    expect(markPullRequestReady).not.toHaveBeenCalled();
    expect(squashMergePullRequest).toHaveBeenCalledWith(15, "Fix coffee bean images (#15)");
    expect(ensureLabel).toHaveBeenCalledWith("merged", "0e8a16", expect.any(String));
    expect(setLabels).toHaveBeenCalledWith(14, ["user-feedback", "approved", "merged"]);
    expect(closeIssue).toHaveBeenCalledWith(14);
    expect(comment).toHaveBeenCalledWith(14, fixMergedComment(PR_URL, SHA));
    expect(notifyFixMerged).toHaveBeenCalledWith({
      number: 14,
      title: issue.title,
      url: issue.url,
      prNumber: 15,
      prUrl: PR_URL,
      sha: SHA,
    });
  });

  it("marks a draft ready before squash-merging", async () => {
    getPullRequest
      .mockResolvedValueOnce(pull({ draft: true }))
      .mockResolvedValueOnce(pull({ draft: false }));

    const outcome = await mergeApprovedFix(14, 15);

    expect(outcome.status).toBe("merged");
    expect(markPullRequestReady).toHaveBeenCalledWith("PR_kwDO");
    expect(squashMergePullRequest).toHaveBeenCalledOnce();
  });

  it("returns a clear error when GitHub rejects markPullRequestReadyForReview", async () => {
    getPullRequest.mockResolvedValue(pull({ draft: true }));
    markPullRequestReady.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 }),
    );

    await expect(mergeApprovedFix(14, 15)).rejects.toThrow(/Pull requests: write/);
    expect(squashMergePullRequest).not.toHaveBeenCalled();
    expect(notifyFixMerged).not.toHaveBeenCalled();
  });

  it("treats an already-merged pull request as success and finishes the issue once", async () => {
    getPullRequest.mockResolvedValue(pull({
      state: "closed",
      merged: true,
      mergeCommitSha: SHA,
    }));

    const first = await mergeApprovedFix(14, 15);
    const second = await mergeApprovedFix(14, 15);

    expect(first.status).toBe("already-merged");
    expect(first.message).toBe("Pull request #15 is already merged.");
    expect(second).toMatchObject({ status: "already-merged", sha: SHA });
    expect(squashMergePullRequest).not.toHaveBeenCalled();
    expect(notifyFixMerged).toHaveBeenCalledTimes(1);
    expect(comment).toHaveBeenCalledTimes(1);
  });

  it("refuses a pull request that is not the one recorded on the issue", async () => {
    await expect(mergeApprovedFix(14, 99)).rejects.toThrow(/not the fix recorded/);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it("refuses a pull request whose head branch does not match the Cursor run", async () => {
    getPullRequest.mockResolvedValue(pull({ headRef: "someone-else" }));
    await expect(mergeApprovedFix(14, 15)).rejects.toThrow(/not the fix recorded/);
    expect(squashMergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a pull request from outside GITHUB_REPO", async () => {
    getPullRequest.mockResolvedValue(pull({ headRepo: "other/fork" }));
    await expect(mergeApprovedFix(14, 15)).rejects.toThrow(/does not belong/);
    expect(squashMergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a closed pull request that was not merged", async () => {
    getPullRequest.mockResolvedValue(pull({ state: "closed", merged: false }));
    await expect(mergeApprovedFix(14, 15)).rejects.toThrow(/closed and was not merged/);
    expect(squashMergePullRequest).not.toHaveBeenCalled();
  });

  it("refuses a pull request GitHub says is not mergeable", async () => {
    getPullRequest.mockResolvedValue(pull({ mergeable: false }));
    await expect(mergeApprovedFix(14, 15)).rejects.toThrow(/cannot be merged yet/);
    expect(squashMergePullRequest).not.toHaveBeenCalled();
  });

  it("accepts an older fix-result comment that only contains the pull URL", async () => {
    comments[0] = { id: 1, body: `Cursor opened a fix: ${PR_URL}\n\n<!-- beanbox-fix-result -->` };
    const outcome = await mergeApprovedFix(14, 15);
    expect(outcome.status).toBe("merged");
  });
});

describe("GET /api/merge", () => {
  it("returns the merge result for a valid link", async () => {
    const res = await GET(mergeRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    await expect(res.json()).resolves.toMatchObject({ status: "merged", prNumber: 15, sha: SHA });
  });

  it("is idempotent when the link is opened again", async () => {
    let merged = false;
    getPullRequest.mockImplementation(async () => pull(merged
      ? { state: "closed", merged: true, mergeCommitSha: SHA }
      : {}));
    squashMergePullRequest.mockImplementation(async () => {
      merged = true;
      return SHA;
    });

    const first = await GET(mergeRequest());
    const second = await GET(mergeRequest());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "merged" });
    await expect(second.json()).resolves.toMatchObject({
      status: "already-merged",
      message: "Pull request #15 is already merged.",
    });
    expect(squashMergePullRequest).toHaveBeenCalledTimes(1);
    expect(notifyFixMerged).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered or expired link before talking to GitHub", async () => {
    const tampered = await GET(mergeRequest(15, mergeToken(14, 16)));
    expect(tampered.status).toBe(403);
    await expect(tampered.json()).resolves.toEqual({ error: "Invalid or tampered link" });

    const expired = await GET(mergeRequest(15, mergeToken(14, 15, Date.now() - MERGE_LINK_TTL_MS - 5000)));
    expect(expired.status).toBe(403);
    await expect(expired.json()).resolves.toEqual({ error: "This merge link has expired." });
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("returns the draft-permission error as JSON", async () => {
    getPullRequest.mockResolvedValue(pull({ draft: true }));
    markPullRequestReady.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by personal access token"), { status: 403 }),
    );
    const res = await GET(mergeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Pull requests: write/);
  });
});
