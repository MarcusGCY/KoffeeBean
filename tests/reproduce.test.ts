import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const triageFeedback = vi.hoisted(() => vi.fn());
const listOpenFeedbackIssues = vi.hoisted(() => vi.fn());
const createIssue = vi.hoisted(() => vi.fn());
const appendReport = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const getFile = vi.hoisted(() => vi.fn());
const getIssue = vi.hoisted(() => vi.fn());
const updateIssue = vi.hoisted(() => vi.fn());
const setLabels = vi.hoisted(() => vi.fn());
const branchSha = vi.hoisted(() => vi.fn());
const compareAgainstMain = vi.hoisted(() => vi.fn());
const dispatchRepro = vi.hoisted(() => vi.fn());
const findReproRun = vi.hoisted(() => vi.fn());
const workflowRunLog = vi.hoisted(() => vi.fn());
const requestReview = vi.hoisted(() => vi.fn());
const continueTracking = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage", () => ({ triageFeedback }));
vi.mock("@/lib/notify", () => ({ requestReview, notifyIntakeClassification: vi.fn() }));
vi.mock("@/lib/fix", () => ({ continueTracking }));
vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    listOpenFeedbackIssues,
    createIssue,
    appendReport,
    closeIssue,
    ensureLabel,
    getFile,
    getIssue,
    updateIssue,
    setLabels,
    branchSha,
    compareAgainstMain,
    dispatchRepro,
    findReproRun,
    workflowRunLog,
  };
});

import { fileFeedback } from "@/lib/file-feedback";
import { FAILURE_OUTPUT_MAX, judgeRepro, parsePending, parseRepro, pendingMarker, reproMarker } from "@/lib/reproduce";
import { resumeRepro } from "@/lib/repro-track";

const ISSUE = { number: 21, url: "https://github.com/acme/beanbox/issues/21" };
const REPORTED = "**Reported by:** Ada (ada@example.com)";
const BRANCH = "beanbox-triage/tote-add-abcd1234";
const MAIN = "a".repeat(40);
const TEST_PATH = "tests/repro/tote-add.test.ts";
const SHA = "b".repeat(40);
const CHECK_URL = "https://github.com/acme/beanbox/actions/runs/99";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 99,
    status: "completed",
    conclusion: "failure" as string | null,
    htmlUrl: CHECK_URL,
    name: `repro ${SHA} ${TEST_PATH}`,
    ...overrides,
  };
}

function report(body: unknown): string {
  return `REPRO_RESULT ${JSON.stringify(body)}`;
}

function failedAssertion(output: string) {
  return {
    testResults: [{
      name: TEST_PATH,
      status: "failed",
      message: "",
      assertionResults: [{ status: "failed", failureMessages: [output] }],
    }],
  };
}

beforeEach(() => {
  triageFeedback.mockReset();
  listOpenFeedbackIssues.mockReset();
  createIssue.mockReset();
  appendReport.mockReset();
  closeIssue.mockReset();
  ensureLabel.mockReset();
  getFile.mockReset();
  getIssue.mockReset();
  updateIssue.mockReset();
  setLabels.mockReset();
  branchSha.mockReset();
  compareAgainstMain.mockReset();
  dispatchRepro.mockReset();
  findReproRun.mockReset();
  workflowRunLog.mockReset();
  requestReview.mockReset();
  continueTracking.mockReset();
  delete process.env.VERCEL;
  process.env.APPROVAL_SECRET = "test-secret";
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue(ISSUE);
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  updateIssue.mockResolvedValue(undefined);
  setLabels.mockResolvedValue(undefined);
  requestReview.mockResolvedValue(undefined);
  continueTracking.mockResolvedValue(undefined);
  dispatchRepro.mockResolvedValue(undefined);
  branchSha.mockResolvedValue(SHA);
  compareAgainstMain.mockResolvedValue({
    baseSha: MAIN,
    ahead: 1,
    behind: 0,
    files: [{ filename: TEST_PATH, status: "added" }],
  });
  getFile.mockResolvedValue("import { expect, test } from 'vitest';\ntest('tote', () => { expect(true).toBe(false); });\n");
  findReproRun.mockResolvedValue(run());
  workflowRunLog.mockResolvedValue(report(failedAssertion("expected 1 to be 2")));
  triageFeedback.mockResolvedValue({
    action: "create",
    title: "Tote will not add",
    body: "Cart skips the tote.",
    testPath: TEST_PATH,
    branch: BRANCH,
  });
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("fileFeedback reproduce gate", () => {
  it("opens an awaiting-review issue when the pinned test has a failed assertion", async () => {
    const output = `HEAD-MARKER ${"x".repeat(FAILURE_OUTPUT_MAX)} TAIL-MARKER`;
    workflowRunLog.mockResolvedValue(report(failedAssertion(output)));

    await fileFeedback("the tote will not add", REPORTED);

    expect(getFile).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(findReproRun).toHaveBeenCalledWith(SHA, TEST_PATH);
    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][2]).toBeUndefined();
    const body = createIssue.mock.calls[0][1] as string;
    expect(body.startsWith("<!-- beanbox-repro ")).toBe(true);
    expect(parseRepro(body)).toEqual({ testPath: TEST_PATH, branch: BRANCH, sha: SHA });
    expect(body).toContain(CHECK_URL);
    expect(body).toContain("TAIL-MARKER");
    expect(body).not.toContain("HEAD-MARKER");
    expect(requestReview).toHaveBeenCalledWith({
      number: 21,
      title: "Tote will not add",
      url: ISSUE.url,
      summary: "Cart skips the tote.",
    });
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("labels cannot-reproduce when the repro check succeeds", async () => {
    findReproRun.mockResolvedValue(run({ conclusion: "success" }));
    workflowRunLog.mockResolvedValue(report({
      testResults: [{
        name: TEST_PATH,
        status: "passed",
        message: "",
        assertionResults: [{ status: "passed", failureMessages: [] }],
      }],
    }));

    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("passed on main");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });

  it("labels cannot-reproduce when triage produces no test", async () => {
    triageFeedback.mockResolvedValue({
      action: "create",
      title: "Unclear report",
      body: "Could not find a bug.",
    });

    await fileFeedback("something feels off", REPORTED);

    expect(branchSha).not.toHaveBeenCalled();
    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
    expect(requestReview).not.toHaveBeenCalled();
  });

  it("rejects the bare slug and logs a modified file against the current main sha", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const bare = await judgeRepro(TEST_PATH, "beanbox-triage/tote-add");
    expect(bare.status).toBe("no-test");
    expect(compareAgainstMain).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("no-test reason=branch=missing name=beanbox-triage/tote-add");

    compareAgainstMain.mockResolvedValue({
      baseSha: MAIN,
      ahead: 1,
      behind: 1,
      files: [{ filename: TEST_PATH, status: "modified" }],
    });
    const modified = await judgeRepro(TEST_PATH, BRANCH);
    expect(modified.status).toBe("no-test");
    const line = log.mock.calls.flat().join("\n");
    expect(line).toContain(`file=modified base=${MAIN} path=${TEST_PATH}`);
    expect(line).toContain("behind=1");
    expect(line).not.toContain("expected 1 to be 2");
    log.mockRestore();
  });

  it("labels cannot-reproduce when the triage commit changes another file", async () => {
    compareAgainstMain.mockResolvedValue({
      baseSha: MAIN,
      ahead: 1,
      behind: 0,
      files: [
        { filename: TEST_PATH, status: "added" },
        { filename: "src/lib/cart.ts", status: "modified" },
      ],
    });

    await fileFeedback("the tote will not add", REPORTED);

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("more than the one reproduction test");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });

  it("labels cannot-reproduce when the test fails to load", async () => {
    workflowRunLog.mockResolvedValue(report({
      testResults: [{
        name: TEST_PATH,
        status: "failed",
        message: "Transform failed with 1 error",
        assertionResults: [],
      }],
    }));

    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("collection, import, or syntax error");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });

  it("saves a repro-pending issue and dispatches the main workflow while the run is queued", async () => {
    process.env.VERCEL = "1";
    findReproRun.mockResolvedValue(null);

    await fileFeedback("the tote will not add", REPORTED);

    expect(dispatchRepro).toHaveBeenCalledWith(TEST_PATH, SHA);
    expect(createIssue.mock.calls[0][2]).toEqual(["repro-pending"]);
    const body = createIssue.mock.calls[0][1] as string;
    expect(body.startsWith("<!-- beanbox-repro-pending ")).toBe(true);
    expect(parsePending(body)).toMatchObject({ testPath: TEST_PATH, branch: BRANCH, sha: SHA });
    expect(requestReview).not.toHaveBeenCalled();
    expect(continueTracking).toHaveBeenCalledWith(21);
  });
});

describe("signed repro markers", () => {
  it("ignores a forged marker and keeps the first signed one", () => {
    const real = reproMarker(TEST_PATH, BRANCH, SHA);
    const forged = `<!-- beanbox-repro ${JSON.stringify({
      testPath: "tests/repro/other.test.ts",
      branch: BRANCH,
      sha: SHA,
    })} ${"ab".repeat(32)} -->`;
    expect(parseRepro(forged)).toBeUndefined();
    expect(parseRepro(`${real}\nshopper says ${forged}`)).toEqual({
      testPath: TEST_PATH,
      branch: BRANCH,
      sha: SHA,
    });
    const pending = pendingMarker({
      title: "Tote",
      summary: "Cart skips the tote.",
      feedback: "the tote will not add",
      reportedBy: REPORTED,
      testPath: TEST_PATH,
      branch: BRANCH,
      sha: SHA,
      startedAt: 1,
    });
    expect(parsePending(pending.replace(/\.[0-9a-f]{64}/, `.${"cd".repeat(32)}`))).toBeUndefined();
  });
});

describe("resumeRepro", () => {
  it("promotes a pending report when the pinned test later fails an assertion", async () => {
    const output = `HEAD-MARKER ${"x".repeat(FAILURE_OUTPUT_MAX)} TAIL-MARKER`;
    const body = pendingMarker({
      title: "Tote will not add",
      summary: "Cart skips the tote.",
      feedback: "the tote will not add",
      reportedBy: REPORTED,
      testPath: TEST_PATH,
      branch: BRANCH,
      sha: SHA,
      startedAt: Date.now(),
    });
    getIssue.mockResolvedValue({
      number: 21,
      title: "Tote will not add",
      body,
      url: ISSUE.url,
      state: "open",
      labels: ["repro-pending"],
    });
    workflowRunLog.mockResolvedValue(report(failedAssertion(output)));

    await expect(resumeRepro(21, 0)).resolves.toMatchObject({ action: "completed", status: "reproduced" });

    expect(dispatchRepro).not.toHaveBeenCalled();
    expect(setLabels).toHaveBeenCalledWith(21, ["user-feedback", "awaiting-review"]);
    const updated = updateIssue.mock.calls[0][1] as string;
    expect(updated).toContain(CHECK_URL);
    expect(updated).toContain("TAIL-MARKER");
    expect(updated).not.toContain("HEAD-MARKER");
    expect(parseRepro(updated)?.sha).toBe(SHA);
    expect(requestReview).toHaveBeenCalledWith(expect.objectContaining({ number: 21 }));
    expect(closeIssue).not.toHaveBeenCalled();
  });
});
