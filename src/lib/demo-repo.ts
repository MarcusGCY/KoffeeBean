import { Octokit } from "@octokit/rest";
import { DEMO_REVERTED_LABEL } from "./demo-status";
import { env, repo } from "./env";
import { FEEDBACK_LABEL } from "./github";
import type { PlannedFile } from "./text-patch";

export type { PlannedFile };

export class MainMovedError extends Error {
  constructor() {
    super("main moved while committing");
    this.name = "MainMovedError";
  }
}

export type FeedbackIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
};

export type MainCommit = {
  sha: string;
  message: string;
  date: string;
};

export type CommitFile = {
  path: string;
  status: string;
  previousPath?: string;
};

export type CommitMeta = {
  sha: string;
  message: string;
  parents: string[];
  files: CommitFile[];
};

export type PullInfo = {
  number: number;
  title: string;
  body: string;
  url: string;
  merged: boolean;
  mergeSha?: string;
  state: string;
};

export interface DemoRepo {
  repoFullName(): string;
  repoUrl(): string;
  /** Commit this deployment was built from, when running on Vercel. */
  deployedSha(): string | undefined;
  feedbackIssues(): Promise<FeedbackIssue[]>;
  commentBodies(issue: number): Promise<string[]>;
  mainCommits(): Promise<MainCommit[]>;
  headSha(): Promise<string>;
  commitMeta(sha: string): Promise<CommitMeta>;
  fileAt(path: string, ref: string): Promise<string | null>;
  /** True when `sha` is main or an ancestor of main. */
  onMain(sha: string): Promise<boolean>;
  /**
   * Pull request details. Null when the token cannot read pull requests
   * or the number does not exist. Callers must still work from commits.
   */
  pull(number: number): Promise<PullInfo | null>;
  commitOnMain(parentSha: string, message: string, files: PlannedFile[]): Promise<string>;
  markIssueReverted(issue: number, body: string): Promise<void>;
}

const COMMIT_PAGE = 50;
const ISSUE_PAGE = 30;

export function githubDemoRepo(): DemoRepo {
  return new GithubDemoRepo();
}

class GithubDemoRepo implements DemoRepo {
  private readonly client = new Octokit({ auth: env("GITHUB_TOKEN") });
  private readonly owner: string;
  private readonly name: string;
  private pullsDenied = false;

  constructor() {
    const parsed = repo();
    this.owner = parsed.owner;
    this.name = parsed.repo;
  }

  repoFullName(): string {
    return `${this.owner}/${this.name}`;
  }

  repoUrl(): string {
    return `https://github.com/${this.owner}/${this.name}`;
  }

  deployedSha(): string | undefined {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
    return sha || undefined;
  }

  async feedbackIssues(): Promise<FeedbackIssue[]> {
    const res = await this.client.issues.listForRepo({
      owner: this.owner,
      repo: this.name,
      state: "all",
      labels: FEEDBACK_LABEL,
      per_page: ISSUE_PAGE,
      sort: "updated",
      direction: "desc",
    });
    return res.data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        state: issue.state === "open" ? "open" : "closed",
        url: issue.html_url,
      }));
  }

  async commentBodies(issue: number): Promise<string[]> {
    const res = await this.client.issues.listComments({
      owner: this.owner,
      repo: this.name,
      issue_number: issue,
      per_page: 100,
    });
    return res.data.map((comment) => comment.body ?? "");
  }

  async mainCommits(): Promise<MainCommit[]> {
    const res = await this.client.repos.listCommits({
      owner: this.owner,
      repo: this.name,
      sha: "main",
      per_page: COMMIT_PAGE,
    });
    return res.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      date: commit.commit.author?.date ?? "",
    }));
  }

  async headSha(): Promise<string> {
    const res = await this.client.git.getRef({
      owner: this.owner,
      repo: this.name,
      ref: "heads/main",
    });
    return res.data.object.sha;
  }

  async commitMeta(sha: string): Promise<CommitMeta> {
    const res = await this.client.repos.getCommit({
      owner: this.owner,
      repo: this.name,
      ref: sha,
    });
    const files = res.data.files ?? [];
    if (files.length >= 300) {
      throw new Error("That commit touches too many files to change safely.");
    }
    return {
      sha: res.data.sha,
      message: res.data.commit.message,
      parents: res.data.parents.map((parent) => parent.sha),
      files: files.map((file) => ({
        path: file.filename,
        status: file.status ?? "modified",
        previousPath: file.previous_filename,
      })),
    };
  }

  async fileAt(path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.client.repos.getContent({
        owner: this.owner,
        repo: this.name,
        path,
        ref,
      });
      const data = res.data;
      if (Array.isArray(data) || data.type !== "file") {
        throw new Error(`${path} is not a file`);
      }
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        throw new Error(`GitHub did not return the contents of ${path}`);
      }
      const text = Buffer.from(data.content, "base64").toString("utf8");
      if (text.includes("\0")) throw new Error(`${path} looks like a binary file`);
      if (text.length > 1_000_000) throw new Error(`${path} is too large to change safely`);
      return text;
    } catch (error) {
      if (githubStatus(error) === 404) return null;
      throw error;
    }
  }

  async onMain(sha: string): Promise<boolean> {
    const res = await this.client.repos.compareCommitsWithBasehead({
      owner: this.owner,
      repo: this.name,
      basehead: `${sha}...main`,
    });
    return res.data.status === "ahead" || res.data.status === "identical";
  }

  async pull(number: number): Promise<PullInfo | null> {
    if (this.pullsDenied) return null;
    try {
      const res = await this.client.pulls.get({
        owner: this.owner,
        repo: this.name,
        pull_number: number,
      });
      return {
        number,
        title: res.data.title,
        body: res.data.body ?? "",
        url: res.data.html_url,
        merged: Boolean(res.data.merged_at),
        mergeSha: res.data.merge_commit_sha ?? undefined,
        state: res.data.state,
      };
    } catch (error) {
      const status = githubStatus(error);
      if (status === 403 || status === 401) {
        this.pullsDenied = true;
        return null;
      }
      if (status === 404) return null;
      throw error;
    }
  }

  async commitOnMain(parentSha: string, message: string, files: PlannedFile[]): Promise<string> {
    const parent = await this.client.git.getCommit({
      owner: this.owner,
      repo: this.name,
      commit_sha: parentSha,
    });
    const tree = await this.client.git.createTree({
      owner: this.owner,
      repo: this.name,
      base_tree: parent.data.tree.sha,
      tree: files.map((file) =>
        file.text === null
          ? { path: file.path, mode: "100644" as const, type: "blob" as const, sha: null }
          : { path: file.path, mode: "100644" as const, type: "blob" as const, content: file.text },
      ),
    });
    const commit = await this.client.git.createCommit({
      owner: this.owner,
      repo: this.name,
      message,
      tree: tree.data.sha,
      parents: [parentSha],
    });
    try {
      await this.client.git.updateRef({
        owner: this.owner,
        repo: this.name,
        ref: "heads/main",
        sha: commit.data.sha,
        force: false,
      });
    } catch (error) {
      if (isNotFastForward(error)) throw new MainMovedError();
      throw error;
    }
    return commit.data.sha;
  }

  async markIssueReverted(issue: number, body: string): Promise<void> {
    try {
      await this.client.issues.createLabel({
        owner: this.owner,
        repo: this.name,
        name: DEMO_REVERTED_LABEL,
        color: "d93f0b",
        description: "Fix was reverted on main so the BeanBox demo can run again",
      });
    } catch (error) {
      if (githubStatus(error) !== 422) throw error;
    }
    await this.client.issues.addLabels({
      owner: this.owner,
      repo: this.name,
      issue_number: issue,
      labels: [DEMO_REVERTED_LABEL],
    });
    await this.client.issues.createComment({
      owner: this.owner,
      repo: this.name,
      issue_number: issue,
      body,
    });
    await this.client.issues.update({
      owner: this.owner,
      repo: this.name,
      issue_number: issue,
      state: "closed",
    });
  }
}

export function githubStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

function isNotFastForward(error: unknown): boolean {
  if (githubStatus(error) !== 422) return false;
  const message = errorText(error);
  return message.includes("fast forward") || message.includes("not a fast forward");
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || !error) return "";
  const record = error as { message?: unknown; response?: { data?: { message?: unknown } } };
  const parts = [record.message, record.response?.data?.message].filter((part): part is string => typeof part === "string");
  return parts.join(" ").toLowerCase();
}

/** Owner-facing GitHub failure text. Never includes the token. */
export function publicGitHubError(error: unknown): string {
  const status = githubStatus(error);
  let message = error instanceof Error ? error.message : "GitHub request failed";
  const token = process.env.GITHUB_TOKEN;
  if (token && token.length > 0 && message.includes(token)) {
    message = message.split(token).join("[redacted]");
  }
  if (status === 403 || status === 401) {
    return "GitHub denied the request. The token needs Contents read/write and Issues read/write on this repo.";
  }
  if (status === 404) return "GitHub could not find that commit, file, or branch.";
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.slice(0, 300) || "GitHub request failed";
}
