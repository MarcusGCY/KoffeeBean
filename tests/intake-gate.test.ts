import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const classifyPost = vi.hoisted(() => vi.fn());
const triageFeedback = vi.hoisted(() => vi.fn());
const listOpenFeedbackIssues = vi.hoisted(() => vi.fn());
const createIssue = vi.hoisted(() => vi.fn());
const appendReport = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const getIssue = vi.hoisted(() => vi.fn());
const notifyIntakeClassification = vi.hoisted(() => vi.fn());
const requestReview = vi.hoisted(() => vi.fn());

vi.mock("@/app/api/triage/classify/route", () => ({ POST: classifyPost }));
vi.mock("@/lib/triage", () => ({ triageFeedback }));
vi.mock("@/lib/notify", () => ({ notifyIntakeClassification, requestReview }));
vi.mock("@/lib/fix", () => ({ continueTracking: vi.fn() }));
vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    listOpenFeedbackIssues,
    createIssue,
    appendReport,
    closeIssue,
    ensureLabel,
    getIssue,
    comment: vi.fn(async () => undefined),
    listComments: vi.fn(async () => []),
  };
});

import { classifyForIntake, decideIntake, intakeCandidates } from "@/lib/intake-gate";
import { fileFeedback } from "@/lib/file-feedback";

const SECRET = "intake-triage-secret-do-not-log";
const REPORTED = "**Reported by:** Marcus (marcus@example.com)";
const RAW = "Please add a weekly bean subscription. Email shopper@example.com.";

function classified(overrides: Record<string, unknown> = {}) {
  return {
    category: "images",
    severity: "S2",
    summary: "House Espresso photo is broken.",
    steps_to_reproduce: ["Open the shop", "Look at House Espresso"],
    suspected_area: "src/lib/images.ts",
    duplicate_of: null,
    duplicate_confidence: 0.1,
    screenshot_findings: null,
    pii_found: [] as string[],
    redacted_text: "The House Espresso photo is broken.",
    confidence: 0.9,
    needs_human: false,
    fallback: false,
    fallback_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  classifyPost.mockReset();
  triageFeedback.mockReset();
  listOpenFeedbackIssues.mockReset();
  createIssue.mockReset();
  appendReport.mockReset();
  closeIssue.mockReset();
  ensureLabel.mockReset();
  getIssue.mockReset();
  notifyIntakeClassification.mockReset();
  requestReview.mockReset();
  delete process.env.TRIAGE_API_SECRET;
  delete process.env.GITHUB_REPO;
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue({ number: 21, url: "https://github.com/acme/beanbox/issues/21" });
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  getIssue.mockResolvedValue({ state: "open", number: 41, title: "Open bug", body: "", url: "", labels: [] });
  appendReport.mockResolvedValue(undefined);
  notifyIntakeClassification.mockResolvedValue(undefined);
  triageFeedback.mockRejectedValue(new Error("agent should not start"));
});

afterEach(() => {
  delete process.env.TRIAGE_API_SECRET;
  delete process.env.GITHUB_REPO;
  vi.restoreAllMocks();
});

describe("decideIntake", () => {
  it("holds S4 feature requests and other non-bugs", () => {
    const feature = decideIntake(classified({
      category: "other",
      severity: "S4",
      summary: "This is a request for subscriptions, not a bug.",
      duplicate_confidence: 0.2,
      redacted_text: "Please add a weekly bean subscription.",
    }));
    const notABug = decideIntake(classified({
      category: "other",
      severity: "S4",
      summary: "The shopper likes the new bags.",
      duplicate_confidence: 0,
    }));
    expect(feature).toMatchObject({ action: "hold", reason: "s4" });
    expect(notABug).toMatchObject({ action: "hold", reason: "s4" });
  });

  it("holds a clear duplicate at the product confidence bar, including S1", () => {
    const clear = decideIntake(classified({
      category: "cart",
      severity: "S2",
      suspected_area: "src/lib/cart.ts",
      duplicate_of: 41,
      duplicate_confidence: 0.8,
    }));
    const checkout = decideIntake(classified({
      category: "checkout",
      severity: "S1",
      suspected_area: "src/lib/checkout.ts",
      duplicate_of: 12,
      duplicate_confidence: 0.9,
    }));
    expect(clear).toMatchObject({ action: "hold", reason: "duplicate" });
    expect(checkout).toMatchObject({ action: "hold", reason: "duplicate" });
  });

  it("does not treat a weak duplicate_of as clear", () => {
    const weakBug = decideIntake(classified({
      duplicate_of: 41,
      duplicate_confidence: 0.79,
    }));
    const weakRequest = decideIntake(classified({
      category: "other",
      severity: "S4",
      duplicate_of: 41,
      duplicate_confidence: 0.79,
    }));
    expect(weakBug).toMatchObject({ action: "file" });
    expect(weakBug).not.toHaveProperty("failure");
    expect(weakRequest).toMatchObject({ action: "hold", reason: "s4" });
  });

  it("files S1–S3, including a regression", () => {
    expect(decideIntake(classified({ category: "checkout", severity: "S1" }))).toMatchObject({ action: "file" });
    expect(decideIntake(classified({
      summary: "House Espresso image regressed after the last fix.",
    }))).toMatchObject({ action: "file" });
    expect(decideIntake(classified({
      category: "other",
      severity: "S3",
      summary: "Spacing regressed on the bag label.",
    }))).toMatchObject({ action: "file" });
  });

  it("fails open on fallback, needs_human, and an unusable payload", () => {
    expect(decideIntake(classified({
      severity: "S4",
      category: "other",
      fallback: true,
      fallback_reason: "json",
      needs_human: true,
    }))).toMatchObject({ action: "file", failure: "fallback_json", classification: { severity: "S4", fallback: true } });
    expect(decideIntake(classified({
      severity: "S4",
      category: "other",
      needs_human: true,
      duplicate_of: 41,
      duplicate_confidence: 0.99,
    }))).toMatchObject({ action: "file", failure: "needs_human" });
    expect(decideIntake({ severity: "nope" })).toEqual({ action: "file", failure: "error" });
  });
});

describe("fileFeedback intake gate", () => {
  it("sends the bearer secret to classify and does not log it", async () => {
    process.env.TRIAGE_API_SECRET = SECRET;
    let auth: string | null = null;
    classifyPost.mockImplementation(async (req: Request) => {
      auth = req.headers.get("authorization");
      return NextResponse.json(classified({ category: "other", severity: "S4" }));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const decision = await classifyForIntake("Please add a weekly bean subscription.");
    expect(decision).toMatchObject({ action: "hold", reason: "s4" });
    expect(auth).toBe(`Bearer ${SECRET}`);
    expect([...log.mock.calls, ...err.mock.calls].flat().join("\n")).not.toContain(SECRET);
  });

  it("sends known-bug candidates with an integer number and a file path only", () => {
    expect(intakeCandidates()).toEqual([
      { number: 72, suspected_area: "src/lib/images.ts" },
      { number: 14, suspected_area: "src/lib/checkout.ts" },
      { number: 4, suspected_area: "src/lib/cart" },
      { number: 25, suspected_area: "src/lib/cart" },
      { number: 31, suspected_area: "src/data/products.json" },
    ]);
    for (const candidate of intakeCandidates()) {
      expect(Object.keys(candidate).sort()).toEqual(["number", "suspected_area"]);
      expect(Number.isInteger(candidate.number)).toBe(true);
      expect(candidate.suspected_area).not.toContain(" ");
    }
  });

  it("passes those candidates and holds S4 without an issue or agent", async () => {
    process.env.TRIAGE_API_SECRET = SECRET;
    listOpenFeedbackIssues.mockResolvedValue([
      { number: 41, title: "Canvas tote never lands in the cart", body: "The button does nothing." },
    ]);
    let payload: { text?: string; candidates?: Record<string, unknown>[] } = {};
    classifyPost.mockImplementation(async (req: Request) => {
      payload = await req.json();
      return NextResponse.json(classified({
        category: "other",
        severity: "S4",
        summary: "This is a request for subscriptions, not a bug.",
        redacted_text: "Please add a weekly bean subscription.",
        duplicate_confidence: 0.2,
        fallback: false,
        needs_human: false,
      }));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await fileFeedback(RAW, REPORTED);

    expect(payload.text).toBe(RAW);
    expect(payload.candidates).toEqual(intakeCandidates());
    expect(payload.candidates?.some((candidate) => "title" in candidate || "body" in candidate || "category" in candidate)).toBe(false);
    expect(triageFeedback).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
    expect(appendReport).not.toHaveBeenCalled();
    expect(notifyIntakeClassification).toHaveBeenCalledTimes(1);
    const signal = notifyIntakeClassification.mock.calls[0][0];
    expect(signal).toMatchObject({
      action: "hold",
      reason: "s4",
      severity: "S4",
      duplicate_of: null,
      fallback: false,
      needs_human: false,
      category: "other",
      summary: "This is a request for subscriptions, not a bug.",
      confidence: 0.9,
      redacted_text: "Please add a weekly bean subscription.",
    });
    expect(signal.issue).toBeUndefined();
    expect(signal.known_case_url).toBeUndefined();
    expect(getIssue).not.toHaveBeenCalled();
    expect(JSON.stringify(signal)).not.toContain("shopper@example.com");
    expect(log.mock.calls.flat().join("\n")).not.toContain("shopper@example.com");
    expect(log.mock.calls.flat().join("\n")).not.toContain(SECRET);
  });

  it("holds a clear duplicate and links the known case when the repo is configured", async () => {
    process.env.GITHUB_REPO = "acme/beanbox";
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "cart",
      severity: "S2",
      suspected_area: "src/lib/cart.ts",
      duplicate_of: 41,
      duplicate_confidence: 0.9,
      summary: "The tote still cannot be added.",
      redacted_text: "Adding the canvas tote still does nothing.",
    })));

    await fileFeedback("Adding the canvas tote still does nothing.", REPORTED);

    expect(triageFeedback).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
    expect(appendReport).not.toHaveBeenCalled();
    expect(notifyIntakeClassification).toHaveBeenCalledWith(expect.objectContaining({
      action: "hold",
      reason: "duplicate",
      severity: "S2",
      duplicate_of: 41,
      fallback: false,
      needs_human: false,
      category: "cart",
      known_case_url: "https://github.com/acme/beanbox/issues/41",
    }));
    expect(notifyIntakeClassification.mock.calls[0][0].issue).toBeUndefined();
    expect(getIssue).toHaveBeenCalledWith(41);
  });

  it("files a regression only when the matched issue was closed as completed", async () => {
    getIssue.mockResolvedValue({ state: "closed", stateReason: "completed", number: 72, title: "House espresso", body: "", url: "", labels: [] });
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "images",
      severity: "S2",
      suspected_area: "src/lib/images.ts",
      duplicate_of: 72,
      duplicate_confidence: 0.92,
      summary: "The House Espresso photo broke again.",
    })));
    triageFeedback.mockResolvedValue({ action: "create", title: "House espresso regressed", body: "Photo broke again." });

    await fileFeedback("The House Espresso photo is broken again.", REPORTED);

    expect(getIssue).toHaveBeenCalledWith(72);
    expect(triageFeedback).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][1]).not.toContain("Intake classify failed");
    expect(notifyIntakeClassification).toHaveBeenCalledWith(expect.objectContaining({
      action: "file",
      reason: "regression",
      severity: "S2",
      duplicate_of: 72,
      fallback: false,
      needs_human: false,
    }));
  });

  it("files as a bug when a closed issue was not completed", async () => {
    const closes = ["not_planned", "duplicate", null] as const;
    for (const stateReason of closes) {
      getIssue.mockResolvedValueOnce({ state: "closed", stateReason, number: 72, title: "House espresso", body: "", url: "", labels: [] });
      classifyPost.mockResolvedValueOnce(NextResponse.json(classified({
        category: "images",
        severity: "S2",
        suspected_area: "src/lib/images.ts",
        duplicate_of: 72,
        duplicate_confidence: 0.92,
      })));
      triageFeedback.mockResolvedValueOnce({ action: "create", title: "House espresso", body: "Photo is broken." });
      await fileFeedback("The House Espresso photo is broken.", REPORTED);
    }
    expect(triageFeedback).toHaveBeenCalledTimes(closes.length);
    expect(createIssue).toHaveBeenCalledTimes(closes.length);
    for (const call of notifyIntakeClassification.mock.calls) {
      expect(call[0]).toMatchObject({ action: "file", reason: "bug", duplicate_of: 72 });
      expect(call[0].reason).not.toBe("regression");
    }
    for (const call of createIssue.mock.calls) {
      expect(call[1]).not.toContain("Intake classify failed");
    }
  });

  it("files when the matched issue state cannot be read", async () => {
    getIssue.mockRejectedValue(new Error("github down"));
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "cart",
      severity: "S2",
      duplicate_of: 25,
      duplicate_confidence: 0.9,
    })));
    triageFeedback.mockResolvedValue({ action: "create", title: "Tote", body: "Still broken." });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await fileFeedback("Adding the canvas tote still does nothing.", REPORTED);

    expect(triageFeedback).toHaveBeenCalledTimes(1);
    expect(notifyIntakeClassification).toHaveBeenCalledWith(expect.objectContaining({
      action: "file",
      reason: "bug",
      duplicate_of: 25,
    }));
    expect(createIssue.mock.calls[0][1]).not.toContain("Intake classify failed");
    expect(err.mock.calls.flat().join("\n")).not.toContain("github down");
  });

  it("omits the known-case link when GITHUB_REPO is not set", async () => {
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "cart",
      severity: "S2",
      duplicate_of: 41,
      duplicate_confidence: 0.9,
    })));
    await fileFeedback("Adding the canvas tote still does nothing.", REPORTED);
    expect(notifyIntakeClassification.mock.calls[0][0].known_case_url).toBeUndefined();
    expect(notifyIntakeClassification.mock.calls[0][0].duplicate_of).toBe(41);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("files an S3 regression through the triage agent without a classify-failure mark", async () => {
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "images",
      severity: "S3",
      summary: "House Espresso spacing regressed.",
    })));
    triageFeedback.mockResolvedValue({
      action: "create",
      title: "House Espresso spacing",
      body: "The label spacing regressed.",
    });

    await fileFeedback("The House Espresso label spacing looks off again.", REPORTED);

    expect(triageFeedback).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][1]).not.toContain("Intake classify failed");
    expect(notifyIntakeClassification).toHaveBeenCalledWith(expect.objectContaining({
      action: "file",
      reason: "bug",
      severity: "S3",
      duplicate_of: null,
      fallback: false,
      needs_human: false,
      category: "images",
      summary: "House Espresso spacing regressed.",
    }));
    expect(notifyIntakeClassification.mock.calls[0][0].issue).toBeUndefined();
  });

  it("fails open on 401 and 503 and marks the issue", async () => {
    for (const status of [401, 503]) {
      classifyPost.mockResolvedValueOnce(NextResponse.json({ error: "nope" }, { status }));
      triageFeedback.mockResolvedValueOnce({ action: "create", title: "Filed anyway", body: "Classify did not run." });
      await fileFeedback("The House Espresso photo is broken.", REPORTED);
    }
    expect(triageFeedback).toHaveBeenCalledTimes(2);
    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(createIssue.mock.calls[0][1]).toContain("Intake classify failed");
    expect(createIssue.mock.calls[0][1]).toContain("(http_401)");
    expect(createIssue.mock.calls[1][1]).toContain("(http_503)");
    expect(notifyIntakeClassification).toHaveBeenCalledTimes(2);
    expect(notifyIntakeClassification.mock.calls[0][0]).toMatchObject({
      action: "file",
      reason: "classify_failed",
      severity: null,
      duplicate_of: null,
      fallback: true,
      needs_human: true,
    });
    expect(notifyIntakeClassification.mock.calls[1][0].reason).toBe("classify_failed");
  });

  it("fails open when classify throws and does not log the error text", async () => {
    classifyPost.mockRejectedValue(new Error(`blew up ${SECRET}`));
    triageFeedback.mockResolvedValue({ action: "merge", issueNumber: 41, title: "Tote", body: "Known." });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await fileFeedback("The House Espresso photo is broken.", REPORTED);

    expect(appendReport).toHaveBeenCalledWith(41, expect.stringContaining("(error)"));
    expect(createIssue).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join("\n")).not.toContain(SECRET);
    expect(err.mock.calls.flat().join("\n")).toContain("Error");
  });
});
