import { Octokit } from "@octokit/rest";
import { env, repo } from "./env";

export const FEEDBACK_LABEL = "user-feedback";
export const LABEL_AWAITING = "awaiting-review";
export const LABEL_APPROVED = "approved";
export const LABEL_FIXING = "cursor-fixing";
export const LABEL_MERGED = "merged";

const gh = () => new Octokit({ auth: env("GITHUB_TOKEN") });

export type OpenIssue = { number: number; title: string; body: string };

export async function listOpenFeedbackIssues(): Promise<OpenIssue[]> {
  const { owner, repo: r } = repo();
  const res = await gh().issues.listForRepo({
    owner, repo: r, state: "open", labels: FEEDBACK_LABEL, per_page: 50,
  });
  return res.data
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "" }));
}

export async function createIssue(title: string, body: string) {
  const { owner, repo: r } = repo();
  const res = await gh().issues.create({
    owner, repo: r, title, body, labels: [FEEDBACK_LABEL, LABEL_AWAITING],
  });
  return { number: res.data.number, url: res.data.html_url };
}

/** Merge a duplicate report into an existing issue as a comment. */
export async function appendReport(number: number, report: string) {
  const { owner, repo: r } = repo();
  const res = await gh().issues.createComment({
    owner, repo: r, issue_number: number,
    body: `**Another user reported this (merged duplicate):**\n\n> ${report.replace(/\n/g, "\n> ")}`,
  });
  return res.data.html_url;
}

export async function getIssue(number: number) {
  const { owner, repo: r } = repo();
  const res = await gh().issues.get({ owner, repo: r, issue_number: number });
  return {
    number, title: res.data.title, body: res.data.body ?? "", url: res.data.html_url,
    state: res.data.state,
    labels: res.data.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
  };
}

export async function setLabels(number: number, labels: string[]) {
  const { owner, repo: r } = repo();
  await gh().issues.setLabels({ owner, repo: r, issue_number: number, labels });
}

export async function comment(number: number, body: string) {
  const { owner, repo: r } = repo();
  await gh().issues.createComment({ owner, repo: r, issue_number: number, body });
}

export async function closeIssue(number: number) {
  const { owner, repo: r } = repo();
  await gh().issues.update({ owner, repo: r, issue_number: number, state: "closed" });
}

export async function listComments(number: number): Promise<{ id: number; body: string }[]> {
  const { owner, repo: r } = repo();
  const res = await gh().issues.listComments({
    owner, repo: r, issue_number: number, per_page: 100,
  });
  return res.data.map((c) => ({ id: c.id, body: c.body ?? "" }));
}

export type PullSnapshot = {
  number: number;
  nodeId: string;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  headRef: string;
  headRepo: string | null;
  baseRepo: string;
  mergeCommitSha?: string;
};

export async function getPullRequest(number: number): Promise<PullSnapshot | null> {
  const { owner, repo: r } = repo();
  try {
    const res = await gh().pulls.get({ owner, repo: r, pull_number: number });
    const data = res.data;
    return {
      number: data.number,
      nodeId: data.node_id,
      title: data.title,
      url: data.html_url,
      state: data.state,
      draft: Boolean(data.draft),
      merged: Boolean(data.merged),
      mergeable: data.mergeable ?? null,
      headRef: data.head.ref,
      headRepo: data.head.repo?.full_name ?? null,
      baseRepo: data.base.repo?.full_name ?? "",
      mergeCommitSha: data.merge_commit_sha ?? undefined,
    };
  } catch (error) {
    if (githubHttpStatus(error) === 404) return null;
    throw error;
  }
}

const READY_MUTATION = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { isDraft }
  }
}`;

/** GraphQL markPullRequestReadyForReview. REST cannot clear a draft. */
export async function markPullRequestReady(nodeId: string): Promise<void> {
  await gh().graphql(READY_MUTATION, { id: nodeId });
}

export async function squashMergePullRequest(number: number, commitTitle: string): Promise<string> {
  const { owner, repo: r } = repo();
  const res = await gh().pulls.merge({
    owner,
    repo: r,
    pull_number: number,
    merge_method: "squash",
    commit_title: commitTitle,
  });
  if (!res.data.sha) throw new Error(res.data.message || "GitHub did not return a merge commit");
  return res.data.sha;
}

/** Create a label when it is missing. 422 means it already exists. */
export async function ensureLabel(name: string, color: string, description: string): Promise<void> {
  const { owner, repo: r } = repo();
  try {
    await gh().issues.createLabel({ owner, repo: r, name, color, description });
  } catch (error) {
    if (githubHttpStatus(error) === 422) return;
    throw error;
  }
}

export function githubHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

/** Open issues the fix pipeline still has to finish. */
export async function listFixingIssueNumbers(): Promise<number[]> {
  const { owner, repo: r } = repo();
  const res = await gh().issues.listForRepo({
    owner, repo: r, state: "open", labels: LABEL_FIXING, per_page: 50,
  });
  return res.data.filter((i) => !i.pull_request).map((i) => i.number);
}

export type ReportRecord = { body: string; createdAt: string };

/**
 * Recent issue bodies and comments, for the feedback rate limit.
 * `since` is GitHub's updated-at filter; callers still check createdAt.
 */
export async function recentReportRecords(sinceIso: string): Promise<ReportRecord[]> {
  const { owner, repo: r } = repo();
  const client = gh();
  const [issues, comments] = await Promise.all([
    client.issues.listForRepo({
      owner, repo: r, state: "all", since: sinceIso, per_page: 100, sort: "created", direction: "desc",
    }),
    client.issues.listCommentsForRepo({
      owner, repo: r, since: sinceIso, per_page: 100, sort: "created", direction: "desc",
    }),
  ]);
  return [
    ...issues.data
      .filter((i) => !i.pull_request)
      .map((i) => ({ body: i.body ?? "", createdAt: i.created_at })),
    ...comments.data.map((c) => ({ body: c.body ?? "", createdAt: c.created_at })),
  ];
}
