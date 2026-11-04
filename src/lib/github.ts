import { Octokit } from "@octokit/rest";
import { env, repo } from "./env";

export const FEEDBACK_LABEL = "user-feedback";
export const LABEL_AWAITING = "awaiting-review";
export const LABEL_APPROVED = "approved";
export const LABEL_FIXING = "cursor-fixing";
export const LABEL_MERGED = "merged";
export const LABEL_CANNOT_REPRODUCE = "cannot-reproduce";
export const LABEL_REPRO_PENDING = "repro-pending";

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

export async function createIssue(
  title: string,
  body: string,
  labels: string[] = [FEEDBACK_LABEL, LABEL_AWAITING],
) {
  const { owner, repo: r } = repo();
  const res = await gh().issues.create({
    owner, repo: r, title, body, labels,
  });
  return { number: res.data.number, url: res.data.html_url };
}

export type ChangedFile = { filename: string; status: string };

export type WorkflowRunSnapshot = {
  id: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  name: string;
};

export type TriageBranch = { name: string; sha: string; committedAt: number };

/** Branches whose names contain `beanbox-triage`, with the tip commit time. */
export async function listTriageBranches(): Promise<TriageBranch[]> {
  const { owner, repo: r } = repo();
  const listed = await gh().repos.listBranches({ owner, repo: r, per_page: 100 });
  const names = listed.data.map((item) => item.name).filter((name) => name.includes("beanbox-triage"));
  const found: TriageBranch[] = [];
  for (const name of names) {
    const commit = await gh().repos.getCommit({ owner, repo: r, ref: name });
    const sha = commit.data.sha.toLowerCase();
    const when = Date.parse(commit.data.commit.committer?.date ?? commit.data.commit.author?.date ?? "");
    if (!/^[0-9a-f]{40}$/.test(sha) || !Number.isFinite(when)) continue;
    found.push({ name, sha, committedAt: when });
  }
  return found;
}

/** Commit at the tip of `branch`, or null when the ref does not exist. */
export async function branchSha(branch: string): Promise<string | null> {
  const { owner, repo: r } = repo();
  try {
    const res = await gh().git.getRef({ owner, repo: r, ref: `heads/${branch}` });
    const sha = res.data.object.sha;
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch (error) {
    if (githubHttpStatus(error) === 404) return null;
    throw error;
  }
}

export type MainCompare = {
  baseSha: string;
  ahead: number;
  behind: number;
  files: ChangedFile[];
};

/** Diff `head` against the current main commit, not the name `main`. */
export async function compareAgainstMain(head: string): Promise<MainCompare | null> {
  const { owner, repo: r } = repo();
  try {
    const main = await gh().git.getRef({ owner, repo: r, ref: "heads/main" });
    const baseSha = main.data.object.sha.toLowerCase();
    const res = await gh().repos.compareCommitsWithBasehead({
      owner,
      repo: r,
      basehead: `${baseSha}...${head}`,
    });
    return {
      baseSha: (res.data.base_commit?.sha ?? baseSha).toLowerCase(),
      ahead: res.data.ahead_by ?? 0,
      behind: res.data.behind_by ?? 0,
      files: (res.data.files ?? []).map((file) => ({
        filename: file.filename,
        status: file.status ?? "",
      })),
    };
  } catch (error) {
    if (githubHttpStatus(error) === 404) return null;
    throw error;
  }
}

/** Files changed between base and head. `main...sha` is the triage diff. */
export async function compareFiles(base: string, head: string): Promise<ChangedFile[]> {
  const { owner, repo: r } = repo();
  const res = await gh().repos.compareCommitsWithBasehead({
    owner, repo: r, basehead: `${base}...${head}`,
  });
  return (res.data.files ?? []).map((file) => ({
    filename: file.filename,
    status: file.status ?? "",
  }));
}

/** Start the repro workflow on main. The definition that runs is main's. */
export async function dispatchRepro(testPath: string, sha: string): Promise<void> {
  const { owner, repo: r } = repo();
  await gh().actions.createWorkflowDispatch({
    owner,
    repo: r,
    workflow_id: "repro.yml",
    ref: "main",
    inputs: { test_path: testPath, test_sha: sha },
  });
}

/** workflow_dispatch run whose name pins this triage commit and test file. */
export async function findReproRun(sha: string, testPath: string): Promise<WorkflowRunSnapshot | null> {
  const { owner, repo: r } = repo();
  const res = await gh().actions.listWorkflowRuns({
    owner, repo: r, workflow_id: "repro.yml", event: "workflow_dispatch", per_page: 30,
  });
  const want = `repro ${sha} ${testPath}`;
  const matches = res.data.workflow_runs.filter((run) => run.name === want || run.display_title === want);
  const latest = matches.sort((a, b) => b.id - a.id)[0];
  if (!latest) return null;
  return {
    id: latest.id,
    status: latest.status ?? "queued",
    conclusion: latest.conclusion,
    htmlUrl: latest.html_url,
    name: latest.name ?? latest.display_title,
  };
}

/** Plain-text log of the repro job, used to read the vitest JSON line. */
export async function workflowRunLog(runId: number): Promise<string> {
  const { owner, repo: r } = repo();
  const jobs = await gh().actions.listJobsForWorkflowRun({ owner, repo: r, run_id: runId });
  const job = jobs.data.jobs.find((item) => item.name === "repro") ?? jobs.data.jobs[0];
  if (!job) return "";
  const log = await gh().actions.downloadJobLogsForWorkflowRun({ owner, repo: r, job_id: job.id });
  const data = log.data as unknown;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}

export async function updateIssue(number: number, body: string): Promise<void> {
  const { owner, repo: r } = repo();
  await gh().issues.update({ owner, repo: r, issue_number: number, body });
}

/** File text at `ref`, or null when GitHub has no such file. */
export async function getFile(path: string, ref: string): Promise<string | null> {
  const { owner, repo: r } = repo();
  try {
    const res = await gh().repos.getContent({ owner, repo: r, path, ref });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") {
      return null;
    }
    const text = Buffer.from(data.content, "base64").toString("utf8");
    if (text.includes("\0") || text.length > 100_000) return null;
    return text;
  } catch (error) {
    if (githubHttpStatus(error) === 404) return null;
    throw error;
  }
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
  return listOpenIssueNumbers(LABEL_FIXING);
}

/** Reports whose reproduction check has not finished. */
export async function listReproPendingIssueNumbers(): Promise<number[]> {
  return listOpenIssueNumbers(LABEL_REPRO_PENDING);
}

async function listOpenIssueNumbers(label: string): Promise<number[]> {
  const { owner, repo: r } = repo();
  const res = await gh().issues.listForRepo({
    owner, repo: r, state: "open", labels: label, per_page: 50,
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
