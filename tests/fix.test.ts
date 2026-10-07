import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());
const getIssue = vi.hoisted(() => vi.fn());
const setLabels = vi.hoisted(() => vi.fn());
const comment = vi.hoisted(() => vi.fn());
const notifyFixCompleted = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create, getRun },
}));

vi.mock("@/lib/github", () => ({
  getIssue,
  setLabels,
  comment,
  FEEDBACK_LABEL: "user-feedback",
  LABEL_APPROVED: "approved",
  LABEL_FIXING: "cursor-fixing",
}));

vi.mock("@/lib/notify", () => ({
  notifyFixCompleted,
}));

import { fixIssue } from "@/lib/fix";

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

beforeEach(() => {
  create.mockReset();
  getRun.mockReset();
  getIssue.mockReset();
  setLabels.mockReset();
  comment.mockReset();
  notifyFixCompleted.mockReset();
  process.env.CURSOR_API_KEY = API_KEY;
  process.env.GITHUB_REPO = "acme/beanbox";
  getIssue.mockResolvedValue(issue);
  setLabels.mockResolvedValue(undefined);
  comment.mockResolvedValue(undefined);
  notifyFixCompleted.mockResolvedValue(undefined);
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
    expect(comment).toHaveBeenCalledWith(14, `Cursor opened a fix: ${PR}`);
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
    expect(comment).toHaveBeenCalledWith(14, `Cursor opened a fix: ${PR}`);
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

    const summary = comment.mock.calls[0][1] as string;
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
});
