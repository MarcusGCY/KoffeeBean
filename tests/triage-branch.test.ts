import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());
const listTriageBranches = vi.hoisted(() => vi.fn());
const compareFiles = vi.hoisted(() => vi.fn());
const branchSha = vi.hoisted(() => vi.fn());
const getFile = vi.hoisted(() => vi.fn());
const findReproRun = vi.hoisted(() => vi.fn());
const dispatchRepro = vi.hoisted(() => vi.fn());
const createIssue = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const listOpenFeedbackIssues = vi.hoisted(() => vi.fn());
const continueTracking = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create, getRun },
}));

vi.mock("@/lib/fix", () => ({ continueTracking }));

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    listTriageBranches,
    compareFiles,
    branchSha,
    getFile,
    findReproRun,
    dispatchRepro,
    createIssue,
    closeIssue,
    ensureLabel,
    listOpenFeedbackIssues,
  };
});

import { fileFeedback } from "@/lib/file-feedback";
import { parsePending } from "@/lib/reproduce";

const AGENT = "bc-7404668c-0000-4000-8000-000000000048";
const RUN = "run-house-espresso";
const TEST_PATH = "tests/repro/house-espresso-image.test.ts";
const SHA = "c".repeat(40);
const MATCH = `cursor/beanbox-triage-${AGENT}`;
const NEWER = "beanbox-triage/newer-unrelated";

function finished(result: string) {
  const wait = vi.fn(async () => {
    throw new Error("wait should not run on Vercel");
  });
  const send = vi.fn(async () => ({ id: RUN, agentId: AGENT, wait }));
  const close = vi.fn();
  create.mockResolvedValueOnce({ agentId: AGENT, send, close });
  getRun.mockResolvedValueOnce({
    id: RUN,
    agentId: AGENT,
    status: "finished",
    result,
  });
}

beforeEach(() => {
  create.mockReset();
  getRun.mockReset();
  listTriageBranches.mockReset();
  compareFiles.mockReset();
  branchSha.mockReset();
  getFile.mockReset();
  findReproRun.mockReset();
  dispatchRepro.mockReset();
  createIssue.mockReset();
  closeIssue.mockReset();
  ensureLabel.mockReset();
  listOpenFeedbackIssues.mockReset();
  continueTracking.mockReset();
  process.env.VERCEL = "1";
  process.env.CURSOR_API_KEY = "test-cursor-key-do-not-log";
  process.env.GITHUB_REPO = "acme/beanbox";
  process.env.APPROVAL_SECRET = "test-secret";
  delete process.env.TRIAGE_MODEL;
  delete process.env.FIX_MODEL;
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue({ number: 48, url: "https://github.com/acme/beanbox/issues/48" });
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  continueTracking.mockResolvedValue(undefined);
  dispatchRepro.mockResolvedValue(undefined);
  branchSha.mockResolvedValue(SHA);
  getFile.mockResolvedValue("import { expect, it } from 'vitest';\nit('image', () => { expect(true).toBe(false); });\n");
  findReproRun.mockResolvedValue(null);
  compareFiles.mockResolvedValue([{ filename: TEST_PATH, status: "added" }]);
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("triage branch fallback", () => {
  it("dispatches when the run snapshot has no git field and GitHub has a matching branch", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}"}`,
      "```",
    ].join("\n"));
    const now = Date.now();
    listTriageBranches.mockResolvedValue([
      { name: NEWER, sha: "d".repeat(40), committedAt: now + 120_000 },
      { name: MATCH, sha: SHA, committedAt: now + 30_000 },
    ]);

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(closeIssue).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["repro-pending"]);
    expect(parsePending(createIssue.mock.calls[0][1] as string)).toMatchObject({
      testPath: TEST_PATH,
      branch: MATCH,
    });
    expect(branchSha).toHaveBeenCalledWith(MATCH);
  });

  it("uses the single repro file when the decision omits testPath", async () => {
    finished([
      "```json",
      '{"action":"create","title":"House espresso image","body":"The photo is wrong."}',
      "```",
    ].join("\n"));
    listTriageBranches.mockResolvedValue([
      { name: MATCH, sha: SHA, committedAt: Date.now() + 30_000 },
    ]);

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("stays no-test when the only beanbox-triage branch predates the run", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}"}`,
      "```",
    ].join("\n"));
    listTriageBranches.mockResolvedValue([
      { name: MATCH, sha: SHA, committedAt: Date.now() - 86_400_000 },
    ]);

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(compareFiles).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(48);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
  });

  it("stays no-test when the fresh branch adds more than the one test", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}"}`,
      "```",
    ].join("\n"));
    listTriageBranches.mockResolvedValue([
      { name: MATCH, sha: SHA, committedAt: Date.now() + 30_000 },
    ]);
    compareFiles.mockResolvedValue([
      { filename: TEST_PATH, status: "added" },
      { filename: "src/lib/images.ts", status: "modified" },
    ]);

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(48);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
  });
});
