import { Octokit } from "@octokit/rest";
import { env, repo } from "./env";

export const FEEDBACK_LABEL = "user-feedback";
export const LABEL_AWAITING = "awaiting-review";
export const LABEL_APPROVED = "approved";
export const LABEL_FIXING = "cursor-fixing";

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
