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
const latestCheck = vi.hoisted(() => vi.fn());
const requestReview = vi.hoisted(() => vi.fn());
const continueTracking = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage", () => ({ triageFeedback }));
vi.mock("@/lib/notify", () => ({ requestReview }));
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
    latestCheck,
  };
});

import { fileFeedback } from "@/lib/file-feedback";
import { FAILURE_OUTPUT_MAX, pendingMarker, REPRO_FAILED } from "@/lib/reproduce";
import { resumeRepro } from "@/lib/repro-track";

const ISSUE = { number: 21, url: "https://github.com/acme/beanbox/issues/21" };
const REPORTED = "**Reported by:** Ada (ada@example.com)";
const BRANCH = "beanbox-triage/tote";
const TEST_PATH = "tests/repro/tote-add.test.ts";
const CHECK_URL = "https://github.com/acme/beanbox/runs/99";

function check(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    conclusion: "success" as string | null,
    htmlUrl: CHECK_URL,
    text: "",
    ...overrides,
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
  latestCheck.mockReset();
  requestReview.mockReset();
  continueTracking.mockReset();
  delete process.env.VERCEL;
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue(ISSUE);
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  updateIssue.mockResolvedValue(undefined);
  setLabels.mockResolvedValue(undefined);
  requestReview.mockResolvedValue(undefined);
  continueTracking.mockResolvedValue(undefined);
  getFile.mockResolvedValue("import { expect, test } from 'vitest';\ntest('tote', () => { expect(true).toBe(false); });\n");
  latestCheck.mockImplementation(async (_ref: string, name: string) => {
    if (name === "repro-setup") return check();
    return check();
  });
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
  it("opens an awaiting-review issue when the repro check fails the test", async () => {
    const output = `${REPRO_FAILED}\nHEAD-MARKER ${"x".repeat(FAILURE_OUTPUT_MAX)} TAIL-MARKER`;
    latestCheck.mockImplementation(async (_ref: string, name: string) => {
      if (name === "repro-setup") return check();
      return check({ conclusion: "failure", text: output });
    });

    await fileFeedback("the tote will not add", REPORTED);

    expect(latestCheck).toHaveBeenCalledWith(BRANCH, "repro");
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0]).toBe("Tote will not add");
    expect(createIssue.mock.calls[0][2]).toBeUndefined();
    const body = createIssue.mock.calls[0][1] as string;
    expect(body).toContain(TEST_PATH);
    expect(body).toContain(CHECK_URL);
    expect(body).toContain("TAIL-MARKER");
    expect(body).not.toContain("HEAD-MARKER");
    expect(body).toContain("beanbox-repro");
    expect(requestReview).toHaveBeenCalledWith({
      number: 21,
      title: "Tote will not add",
      url: ISSUE.url,
      summary: "Cart skips the tote.",
    });
    expect(closeIssue).not.toHaveBeenCalled();
    expect(continueTracking).not.toHaveBeenCalled();
  });

  it("labels cannot-reproduce when the repro check succeeds", async () => {
    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("passed on main");
    expect(createIssue.mock.calls[0][1]).toContain(TEST_PATH);
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

    expect(getFile).not.toHaveBeenCalled();
    expect(latestCheck).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });

  it("labels cannot-reproduce when the check fails during setup", async () => {
    latestCheck.mockImplementation(async (_ref: string, name: string) => {
      if (name === "repro") return check({ conclusion: "skipped", text: "" });
      return check({ conclusion: "failure", htmlUrl: "https://github.com/acme/beanbox/runs/7", text: "npm ci failed" });
    });

    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("install or setup");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });

  it("saves a repro-pending issue and hands off while the check is running", async () => {
    process.env.VERCEL = "1";
    latestCheck.mockResolvedValue(check({ status: "in_progress", conclusion: null, htmlUrl: "", text: "" }));

    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue.mock.calls[0][2]).toEqual(["repro-pending"]);
    const body = createIssue.mock.calls[0][1] as string;
    expect(body).toContain(TEST_PATH);
    expect(body).toContain(BRANCH);
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
    expect(continueTracking).toHaveBeenCalledWith(21);
  });
});

describe("resumeRepro", () => {
  it("promotes a pending report when the repro check later fails the test", async () => {
    const output = `${REPRO_FAILED}\nHEAD-MARKER ${"x".repeat(FAILURE_OUTPUT_MAX)} TAIL-MARKER`;
    const body = pendingMarker({
      title: "Tote will not add",
      summary: "Cart skips the tote.",
      feedback: "the tote will not add",
      reportedBy: REPORTED,
      testPath: TEST_PATH,
      branch: BRANCH,
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
    latestCheck.mockImplementation(async (_ref: string, name: string) => {
      if (name === "repro-setup") return check();
      return check({ conclusion: "failure", text: output });
    });

    await expect(resumeRepro(21, 0)).resolves.toMatchObject({ action: "completed", status: "reproduced" });

    expect(setLabels).toHaveBeenCalledWith(21, ["user-feedback", "awaiting-review"]);
    const updated = updateIssue.mock.calls[0][1] as string;
    expect(updated).toContain(TEST_PATH);
    expect(updated).toContain(CHECK_URL);
    expect(updated).toContain("TAIL-MARKER");
    expect(updated).not.toContain("HEAD-MARKER");
    expect(requestReview).toHaveBeenCalledWith(expect.objectContaining({ number: 21, url: ISSUE.url }));
    expect(createIssue).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });
});
