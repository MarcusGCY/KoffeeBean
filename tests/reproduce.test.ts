import { beforeEach, describe, expect, it, vi } from "vitest";

const triageFeedback = vi.hoisted(() => vi.fn());
const listOpenFeedbackIssues = vi.hoisted(() => vi.fn());
const createIssue = vi.hoisted(() => vi.fn());
const appendReport = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const getFile = vi.hoisted(() => vi.fn());
const requestReview = vi.hoisted(() => vi.fn());
const runTestOnMain = vi.hoisted(() => vi.fn());

vi.mock("@/lib/triage", () => ({ triageFeedback }));

vi.mock("@/lib/notify", () => ({ requestReview }));

vi.mock("@/lib/run-test", () => ({ runTestOnMain }));

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
  };
});

import { fileFeedback } from "@/lib/file-feedback";
import { FAILURE_OUTPUT_MAX } from "@/lib/reproduce";

const ISSUE = { number: 21, url: "https://github.com/acme/beanbox/issues/21" };
const REPORTED = "**Reported by:** Ada (ada@example.com)";

beforeEach(() => {
  triageFeedback.mockReset();
  listOpenFeedbackIssues.mockReset();
  createIssue.mockReset();
  appendReport.mockReset();
  closeIssue.mockReset();
  ensureLabel.mockReset();
  getFile.mockReset();
  requestReview.mockReset();
  runTestOnMain.mockReset();
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue(ISSUE);
  appendReport.mockResolvedValue("https://github.com/acme/beanbox/issues/7#issuecomment-1");
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  requestReview.mockResolvedValue(undefined);
  getFile.mockResolvedValue("import { expect, test } from 'vitest';\ntest('tote', () => { expect(true).toBe(false); });\n");
});

describe("fileFeedback reproduce gate", () => {
  it("opens an awaiting-review issue with the test path and trimmed failure output", async () => {
    triageFeedback.mockResolvedValue({
      action: "create",
      title: "Tote will not add",
      body: "Cart skips the tote.",
      testPath: "tests/repro/tote-add.test.ts",
      branch: "cursor/triage-tote",
    });
    const output = `HEAD-MARKER ${"x".repeat(FAILURE_OUTPUT_MAX)} TAIL-MARKER`;
    runTestOnMain.mockResolvedValue({ code: 1, output });

    await fileFeedback("the tote will not add", REPORTED);

    expect(getFile).toHaveBeenCalledWith("tests/repro/tote-add.test.ts", "cursor/triage-tote");
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0]).toBe("Tote will not add");
    expect(createIssue.mock.calls[0][2]).toBeUndefined();
    const body = createIssue.mock.calls[0][1] as string;
    expect(body).toContain("tests/repro/tote-add.test.ts");
    expect(body).toContain("cursor/triage-tote");
    expect(body).toContain("TAIL-MARKER");
    expect(body).not.toContain("HEAD-MARKER");
    expect(body).toContain("beanbox-repro");
    expect(body).toContain("the tote will not add");
    expect(requestReview).toHaveBeenCalledWith({
      number: 21,
      title: "Tote will not add",
      url: ISSUE.url,
      summary: "Cart skips the tote.",
    });
    expect(closeIssue).not.toHaveBeenCalled();
    expect(ensureLabel).not.toHaveBeenCalled();
  });

  it("labels cannot-reproduce when the test passes on main", async () => {
    triageFeedback.mockResolvedValue({
      action: "create",
      title: "Tote will not add",
      body: "Cart skips the tote.",
      testPath: "tests/repro/tote-add.test.ts",
      branch: "cursor/triage-tote",
    });
    runTestOnMain.mockResolvedValue({ code: 0, output: "Test Files  1 passed" });

    await fileFeedback("the tote will not add", REPORTED);

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    const body = createIssue.mock.calls[0][1] as string;
    expect(body).toContain("passed on main");
    expect(body).toContain("tests/repro/tote-add.test.ts");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
    expect(ensureLabel).toHaveBeenCalledWith("cannot-reproduce", expect.any(String), expect.any(String));
  });

  it("labels cannot-reproduce when triage produces no test", async () => {
    triageFeedback.mockResolvedValue({
      action: "create",
      title: "Unclear report",
      body: "Could not find a bug.",
    });

    await fileFeedback("something feels off", REPORTED);

    expect(getFile).not.toHaveBeenCalled();
    expect(runTestOnMain).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][2]).toEqual(["user-feedback", "cannot-reproduce"]);
    expect(createIssue.mock.calls[0][1]).toContain("did not produce a test");
    expect(requestReview).not.toHaveBeenCalled();
    expect(closeIssue).toHaveBeenCalledWith(21);
  });
});
