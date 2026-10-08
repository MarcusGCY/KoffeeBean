import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());
const listRuns = vi.hoisted(() => vi.fn());
const getIssue = vi.hoisted(() => vi.fn());
const setLabels = vi.hoisted(() => vi.fn());
const comment = vi.hoisted(() => vi.fn());
const listComments = vi.hoisted(() => vi.fn());
const listFixingIssueNumbers = vi.hoisted(() => vi.fn());
const notifyFixCompleted = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create, getRun, listRuns },
}));

vi.mock("@/lib/github", () => ({
  getIssue,
  setLabels,
  comment,
  listComments,
  listFixingIssueNumbers,
  FEEDBACK_LABEL: "user-feedback",
  LABEL_APPROVED: "approved",
  LABEL_FIXING: "cursor-fixing",
}));

vi.mock("@/lib/notify", () => ({
  notifyFixCompleted,
}));

import { fixIssue, resumeFix } from "@/lib/fix";
import { fixResultComment, fixRunComment } from "@/lib/fix-marker";
import { SERVERLESS_TRACK_BUDGET_MS } from "@/lib/run-status";

const API_KEY = "test-cursor-key-do-not-log";
const RUN = "run-11111111-1111-4111-8111-111111111111";
const AGENT = "bc-22222222-2222-4222-8222-222222222222";
const PR = "https://github.com/acme/beanbox/pull/15";

const issue = {
  number: 14,
  title: "Checkout total wrong",
  body: "Tax is off",
  url: "https://github.com/acme/beanbox/issues/14",
  labels: ["user-feedback"],
};

function agentWith(wait: () => Promise<unknown>) {
  const close = vi.fn();
  const send = vi.fn(async () => ({ id: RUN, agentId: AGENT, wait }));
  return { agentId: AGENT, send, close };
}

let labels: string[] = ["user-feedback"];
const comments: { id: number; body: string }[] = [];

beforeEach(() => {
  create.mockReset();
  getRun.mockReset();
  listRuns.mockReset();
  getIssue.mockReset();
  setLabels.mockReset();
  comment.mockReset();
  listComments.mockReset();
  listFixingIssueNumbers.mockReset();
  notifyFixCompleted.mockReset();
  labels = ["user-feedback"];
  comments.length = 0;
  process.env.CURSOR_API_KEY = API_KEY;
  process.env.GITHUB_REPO = "acme/beanbox";
  delete process.env.VERCEL;
  delete process.env.CRON_SECRET;
  getIssue.mockImplementation(async () => ({ ...issue, labels: [...labels] }));
  setLabels.mockImplementation(async (_n: number, next: string[]) => {
    labels = [...next];
  });
  let commentId = 1;
  comment.mockImplementation(async (_n: number, body: string) => {
    comments.push({ id: commentId++, body });
  });
  listComments.mockImplementation(async () => comments.map((c) => ({ ...c })));
  listFixingIssueNumbers.mockResolvedValue([]);
  listRuns.mockResolvedValue({ items: [] });
  notifyFixCompleted.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.VERCEL;
  delete process.env.CRON_SECRET;
});

describe("fixIssue", () => {
  it("logs the agent and run ids and posts the PR when wait() finishes", async () => {
    const handle = agentWith(async () => ({
      id: RUN,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    }));
    create.mockResolvedValue(handle);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const outcome = await fixIssue(14);

    expect(log).toHaveBeenCalledWith(`[fix] agent=${AGENT} run=${RUN}`);
    expect(outcome).toEqual({ status: "finished", prUrl: PR });
    expect(getRun).not.toHaveBeenCalled();
    expect(comment).toHaveBeenCalledWith(14, fixResultComment(`Cursor opened a fix: ${PR}`));
    expect(comment).toHaveBeenCalledWith(14, expect.stringContaining(`"runId":"${RUN}"`));
    expect(notifyFixCompleted).toHaveBeenCalledWith({
      number: 14,
      title: issue.title,
      url: issue.url,
      status: "finished",
      prUrl: PR,
      summary: `Cursor opened a fix: ${PR}`,
    });
    expect(handle.close).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("uses the polled PR when wait() returns a false error", async () => {
    const handle = agentWith(async () => ({
      id: RUN,
      status: "error",
      error: { message: "stream 404", code: "not_found" },
    }));
    create.mockResolvedValue(handle);
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    const outcome = await fixIssue(14);

    expect(outcome).toEqual({ status: "finished", prUrl: PR });
    expect(comment).toHaveBeenCalledWith(14, fixResultComment(`Cursor opened a fix: ${PR}`));
    expect(notifyFixCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: "finished",
      prUrl: PR,
      summary: `Cursor opened a fix: ${PR}`,
    }));
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("puts the confirmed error message and code in the comment and fix_completed summary", async () => {
    const handle = agentWith(async () => ({
      id: RUN,
      status: "error",
      error: { message: "stream 404", code: "not_found" },
    }));
    create.mockResolvedValue(handle);
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "error",
      error: { message: `agent exploded near ${API_KEY}`, code: "internal" },
    });

    const outcome = await fixIssue(14);

    const summary = notifyFixCompleted.mock.calls[0][0].summary as string;
    expect(comment).toHaveBeenCalledWith(14, fixResultComment(summary));
    expect(outcome).toEqual({ status: "error", prUrl: undefined });
    expect(summary).toContain("Cursor run ended with status `error`.");
    expect(summary).toContain("agent exploded near [redacted] (internal).");
    expect(summary).toContain("No PR was created.");
    expect(summary).not.toContain(API_KEY);
    expect(summary).not.toContain("not_found");
    expect(notifyFixCompleted).toHaveBeenCalledWith({
      number: 14,
      title: issue.title,
      url: issue.url,
      status: "error",
      prUrl: undefined,
      summary,
    });
  });

  it("on Vercel publishes when getRun is already finished and does not call wait()", async () => {
    process.env.VERCEL = "1";
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    const handle = agentWith(wait);
    create.mockResolvedValue(handle);
    const conversation = vi.fn(async () => {
      throw new Error("fix_completed reads git.prUrl from getRun, not the assistant transcript");
    });
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
      conversation,
    });

    const outcome = await fixIssue(14);

    expect(wait).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "finished", prUrl: PR });
    expect(notifyFixCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: "finished",
      prUrl: PR,
      summary: `Cursor opened a fix: ${PR}`,
    }));
  });

  it("on Vercel leaves a still-running fix pending without fix_completed", async () => {
    vi.useFakeTimers();
    process.env.VERCEL = "1";
    const handle = agentWith(async () => ({ id: RUN, status: "running" }));
    create.mockResolvedValue(handle);
    getRun.mockResolvedValue({ id: RUN, agentId: AGENT, status: "running" });

    const pending = fixIssue(14);
    await vi.advanceTimersByTimeAsync(SERVERLESS_TRACK_BUDGET_MS + 1000);
    const outcome = await pending;

    expect(outcome).toEqual({ status: "running", prUrl: undefined, pending: true });
    expect(notifyFixCompleted).not.toHaveBeenCalled();
    expect(comment).toHaveBeenCalledWith(14, expect.stringContaining(`"runId":"${RUN}"`));
    expect(handle.close).toHaveBeenCalledOnce();
    expect(labels).toContain("cursor-fixing");
  });

  it("resumeFix publishes once, then skips once the fixing label is gone", async () => {
    labels = ["user-feedback", "approved", "cursor-fixing"];
    comments.push({
      id: 1,
      body: fixRunComment({ agentId: AGENT, runId: RUN, startedAt: Date.now() }),
    });
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    await expect(resumeFix(14)).resolves.toMatchObject({
      action: "completed",
      status: "finished",
      prUrl: PR,
    });
    await expect(resumeFix(14)).resolves.toEqual({ action: "skipped", reason: "not-fixing" });
    expect(notifyFixCompleted).toHaveBeenCalledTimes(1);
    expect(notifyFixCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: "finished",
      prUrl: PR,
      summary: `Cursor opened a fix: ${PR}`,
    }));
  });
});
