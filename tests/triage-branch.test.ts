import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());
const compareAgainstMain = vi.hoisted(() => vi.fn());
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
    compareAgainstMain,
    branchSha,
    getFile,
    findReproRun,
    dispatchRepro,
    createIssue,
    closeIssue,
    ensureLabel,
    listOpenFeedbackIssues,
    comment: vi.fn(async () => undefined),
    listComments: vi.fn(async () => []),
    updateIssue: vi.fn(async () => undefined),
    setLabels: vi.fn(async () => undefined),
  };
});

import { fileFeedback } from "@/lib/file-feedback";
import { parsePending } from "@/lib/reproduce";

const AGENT = "bc-7404668c-0000-4000-8000-000000000048";
const RUN = "run-house-espresso";
const TEST_PATH = "tests/repro/house-espresso-image.test.ts";
const SHA = "c".repeat(40);
const MAIN = "a".repeat(40);
const MATCH = "beanbox-triage/house-espresso-image-bc-74046";

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
  compareAgainstMain.mockReset();
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
  compareAgainstMain.mockResolvedValue({
    baseSha: MAIN,
    ahead: 1,
    behind: 0,
    files: [{ filename: TEST_PATH, status: "added" }],
  });
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("triage branch fallback", () => {
  it("dispatches the exact branch for this run and ignores a bare slug", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}","branch":"beanbox-triage/house-espresso-image"}`,
      "```",
    ].join("\n"));

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(closeIssue).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["repro-pending"]);
    expect(parsePending(createIssue.mock.calls[0][1] as string)).toMatchObject({
      testPath: TEST_PATH,
      branch: MATCH,
    });
    expect(branchSha).toHaveBeenCalledWith(MATCH);
    expect(compareAgainstMain).toHaveBeenCalledWith(MATCH);
  });

  it("uses the exact branch when the decision omits testPath", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","branch":"${MATCH}"}`,
      "```",
    ].join("\n"));

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("stays no-test when the exact branch is missing", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}"}`,
      "```",
    ].join("\n"));
    branchSha.mockResolvedValue(null);

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(compareAgainstMain).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(48);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
  });

  it("stays no-test when the exact branch adds more than the one test", async () => {
    finished([
      "```json",
      `{"action":"create","title":"House espresso image","body":"The photo is wrong.","testPath":"${TEST_PATH}"}`,
      "```",
    ].join("\n"));
    compareAgainstMain.mockResolvedValue({
      baseSha: MAIN,
      ahead: 1,
      behind: 0,
      files: [
        { filename: TEST_PATH, status: "added" },
        { filename: "src/lib/images.ts", status: "modified" },
      ],
    });

    await fileFeedback("house espresso image is wrong", "**Reported by:** Marcus");

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(48);
    expect(createIssue.mock.calls[0][1]).toContain("more than the one reproduction test");
  });
});
