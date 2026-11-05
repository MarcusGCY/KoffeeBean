import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const classifyPost = vi.hoisted(() => vi.fn());
const triageFeedback = vi.hoisted(() => vi.fn());
const listOpenFeedbackIssues = vi.hoisted(() => vi.fn());
const createIssue = vi.hoisted(() => vi.fn());
const appendReport = vi.hoisted(() => vi.fn());
const closeIssue = vi.hoisted(() => vi.fn());
const ensureLabel = vi.hoisted(() => vi.fn());
const notifyIntakeOnly = vi.hoisted(() => vi.fn());
const requestReview = vi.hoisted(() => vi.fn());

vi.mock("@/app/api/triage/classify/route", () => ({ POST: classifyPost }));
vi.mock("@/lib/triage", () => ({ triageFeedback }));
vi.mock("@/lib/notify", () => ({ notifyIntakeOnly, requestReview }));
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
  };
});

import { classifyForIntake, decideIntake } from "@/lib/intake-gate";
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
  notifyIntakeOnly.mockReset();
  requestReview.mockReset();
  delete process.env.TRIAGE_API_SECRET;
  delete process.env.GITHUB_REPO;
  listOpenFeedbackIssues.mockResolvedValue([]);
  createIssue.mockResolvedValue({ number: 21, url: "https://github.com/acme/beanbox/issues/21" });
  closeIssue.mockResolvedValue(undefined);
  ensureLabel.mockResolvedValue(undefined);
  appendReport.mockResolvedValue(undefined);
  notifyIntakeOnly.mockResolvedValue(undefined);
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
    expect(weakBug).toEqual({ action: "file" });
    expect(weakRequest).toMatchObject({ action: "hold", reason: "s4" });
  });

  it("files S1–S3, including a regression", () => {
    expect(decideIntake(classified({ category: "checkout", severity: "S1" }))).toEqual({ action: "file" });
    expect(decideIntake(classified({
      summary: "House Espresso image regressed after the last fix.",
    }))).toEqual({ action: "file" });
    expect(decideIntake(classified({
      category: "other",
      severity: "S3",
      summary: "Spacing regressed on the bag label.",
    }))).toEqual({ action: "file" });
  });

  it("fails open on fallback, needs_human, and an unusable payload", () => {
    expect(decideIntake(classified({
      severity: "S4",
      category: "other",
      fallback: true,
      fallback_reason: "json",
      needs_human: true,
    }))).toEqual({ action: "file", failure: "fallback_json" });
    expect(decideIntake(classified({
      severity: "S4",
      category: "other",
      needs_human: true,
      duplicate_of: 41,
      duplicate_confidence: 0.99,
    }))).toEqual({ action: "file", failure: "needs_human" });
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
    const decision = await classifyForIntake("Please add a weekly bean subscription.", []);
    expect(decision).toMatchObject({ action: "hold", reason: "s4" });
    expect(auth).toBe(`Bearer ${SECRET}`);
    expect([...log.mock.calls, ...err.mock.calls].flat().join("\n")).not.toContain(SECRET);
  });

  it("passes open issues as candidates and holds S4 without an issue or agent", async () => {
    process.env.TRIAGE_API_SECRET = SECRET;
    listOpenFeedbackIssues.mockResolvedValue([
      { number: 41, title: "Canvas tote never lands in the cart", body: "The button does nothing." },
    ]);
    let payload: { text?: string; candidates?: { number: number; title: string; category?: string }[] } = {};
    classifyPost.mockImplementation(async (req: Request) => {
      payload = await req.json();
      return NextResponse.json(classified({
        category: "other",
        severity: "S4",
        summary: "This is a request for subscriptions, not a bug.",
        redacted_text: "Please add a weekly bean subscription.",
        duplicate_confidence: 0.2,
      }));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await fileFeedback(RAW, REPORTED);

    expect(payload.text).toBe(RAW);
    expect(payload.candidates).toEqual([
      { number: 41, title: "Canvas tote never lands in the cart", body: "The button does nothing." },
    ]);
    expect(payload.candidates?.[0]).not.toHaveProperty("category");
    expect(triageFeedback).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
    expect(appendReport).not.toHaveBeenCalled();
    expect(notifyIntakeOnly).toHaveBeenCalledTimes(1);
    const signal = notifyIntakeOnly.mock.calls[0][0];
    expect(signal.reason).toBe("s4");
    expect(signal.issue).toBeUndefined();
    expect(signal.knownCaseUrl).toBeUndefined();
    expect(signal.classification).toMatchObject({
      severity: "S4",
      category: "other",
      redacted_text: "Please add a weekly bean subscription.",
    });
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
    expect(notifyIntakeOnly).toHaveBeenCalledWith(expect.objectContaining({
      reason: "duplicate",
      knownCaseUrl: "https://github.com/acme/beanbox/issues/41",
      classification: expect.objectContaining({ duplicate_of: 41, severity: "S2" }),
    }));
    expect(notifyIntakeOnly.mock.calls[0][0].issue).toBeUndefined();
  });

  it("omits the known-case link when GITHUB_REPO is not set", async () => {
    classifyPost.mockResolvedValue(NextResponse.json(classified({
      category: "cart",
      severity: "S2",
      duplicate_of: 41,
      duplicate_confidence: 0.9,
    })));
    await fileFeedback("Adding the canvas tote still does nothing.", REPORTED);
    expect(notifyIntakeOnly.mock.calls[0][0].knownCaseUrl).toBeUndefined();
    expect(notifyIntakeOnly.mock.calls[0][0].classification.duplicate_of).toBe(41);
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
    expect(notifyIntakeOnly).not.toHaveBeenCalled();
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
    expect(notifyIntakeOnly).not.toHaveBeenCalled();
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
