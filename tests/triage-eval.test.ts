import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printScorecard, runTriageEval } from "@/lib/triage-eval";
import {
  categoryAccuracy,
  decide,
  duplicateFalsePositives,
  duplicatePrecision,
  duplicateRecall,
  hasSkippedOrWeakenedTest,
  reproGate,
  scoreLabels,
  severityExactRate,
  suiteGreen,
  summarize,
  type ScoredCase,
} from "@/lib/triage-score";

const root = path.join(process.cwd(), "evals/triage");

function row(partial: Partial<ScoredCase> & Pick<ScoredCase, "id">): ScoredCase {
  return {
    schemaValid: true,
    categoryMatch: true,
    severityExact: true,
    severityDistance: 0,
    expectedDuplicate: null,
    predictedDuplicate: null,
    piiLeaks: [],
      error: false,
      ...partial,
    };
}

describe("triage eval scoring", () => {
  it("scores category, severity distance, and duplicate precision", () => {
    const cases = [
      row({ id: "a", expectedDuplicate: 41, predictedDuplicate: 41 }),
      row({ id: "b", categoryMatch: false }),
      row({ id: "c", severityExact: false, severityDistance: 1, predictedDuplicate: 9, expectedDuplicate: null }),
    ];
    expect(categoryAccuracy(cases)).toBeCloseTo(2 / 3);
    expect(severityExactRate(cases)).toBeCloseTo(2 / 3);
    expect(duplicatePrecision(cases)).toBeCloseTo(0.5);
    expect(duplicateRecall(cases)).toBe(1);
    expect(duplicateFalsePositives(cases)).toBe(1);
    const gates = {
      schemaValid: true,
      piiClean: true,
      repro: { status: "na" as const, detail: "n/a" },
      skips: [],
      testsGreen: true,
      categoryAccuracy: 0.9,
      severityExact: 0.8,
      maxSeverityDistance: 1,
      duplicatePrecision: 0.9,
      errorCount: 0,
      errorRate: 0,
    };
    expect(decide(cases, gates)).toBe("GO");
    expect(decide(cases, { ...gates, maxSeverityDistance: 2 })).toBe("NO-GO");
    expect(decide(cases, { ...gates, duplicatePrecision: 0.5 })).toBe("NO-GO");
    expect(decide(cases, { ...gates, piiClean: false })).toBe("NO-GO");
    const withError = summarize(
      [row({ id: "ok", severityDistance: 0 }), row({ id: "bad", error: true, severityDistance: 99, schemaValid: false })],
      { repro: { status: "na", detail: "n/a" }, skips: [], testsGreen: true },
    );
    expect(withError.maxSeverityDistance).toBe(0);
    expect(withError.errorCount).toBe(1);
    expect(withError.decision).toBe("NO-GO");
  });

  it("scores duplicate recall as a target and counts false positives beside it", () => {
    const cases = [
      row({ id: "hit", expectedDuplicate: 41, predictedDuplicate: 41 }),
      row({ id: "miss", expectedDuplicate: 41, predictedDuplicate: null }),
      row({ id: "fp", expectedDuplicate: null, predictedDuplicate: 9 }),
      row({ id: "err", expectedDuplicate: 7, predictedDuplicate: null, error: true, schemaValid: false }),
    ];
    expect(duplicateRecall(cases)).toBeCloseTo(1 / 3);
    expect(duplicateFalsePositives(cases)).toBe(1);
    expect(duplicateRecall([row({ id: "none" })])).toBe(1);
    const lowRecall = summarize(
      [
        row({ id: "hit", expectedDuplicate: 41, predictedDuplicate: 41 }),
        row({ id: "miss", expectedDuplicate: 41, predictedDuplicate: null }),
      ],
      { repro: { status: "na", detail: "n/a" }, skips: [], testsGreen: true },
    );
    expect(lowRecall.duplicateRecall).toBeCloseTo(0.5);
    expect(lowRecall.duplicateFalsePositives).toBe(0);
    expect(lowRecall.duplicatePrecision).toBe(1);
    expect(lowRecall.decision).toBe("GO");
  });

  it("treats a missing repro pair as n/a and requires a fail then a pass", () => {
    expect(reproGate(null, null).status).toBe("na");
    expect(reproGate({ success: false }, null).status).toBe("fail");
    expect(reproGate({ success: false, numFailedTests: 1 }, { success: true, numFailedTests: 0 }).status).toBe("pass");
    expect(
      reproGate(
        { testResults: [{ name: "tests/repro/tote.test.ts", status: "passed" }] },
        { success: true },
      ).status,
    ).toBe("fail");
  });

  it("reuses testSkips and also flags .only, ignoring those words inside strings", () => {
    expect(hasSkippedOrWeakenedTest('it.skip("x", () => {})')).toBe(true);
    expect(hasSkippedOrWeakenedTest('test.todo("later")')).toBe(true);
    expect(hasSkippedOrWeakenedTest('describe.only("x", () => {})')).toBe(true);
    expect(hasSkippedOrWeakenedTest('const note = "do not use .skip or .todo";')).toBe(false);
    expect(suiteGreen({ success: true })).toBe(true);
    expect(suiteGreen({ success: false, numFailedTests: 1 })).toBe(false);
  });

  it("runs the mocked cases and returns GO", async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "triage-eval-"));
    const report = await runTriageEval({
      casesDir: root,
      outputDir,
      testsDir: path.join(process.cwd(), "tests"),
      testResultPath: path.join(process.cwd(), "evals/samples/vitest-green.json"),
      quiet: true,
    });
    expect(report.cases).toHaveLength(15);
    expect(report.gates.schemaValid).toBe(true);
    expect(report.gates.piiClean).toBe(true);
    expect(report.gates.repro.status).toBe("na");
    expect(report.gates.categoryAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(report.gates.severityExact).toBeGreaterThanOrEqual(0.8);
    expect(report.gates.maxSeverityDistance).toBeLessThanOrEqual(1);
    expect(report.gates.duplicatePrecision).toBeGreaterThanOrEqual(0.9);
    expect(report.gates.duplicateRecall).toBe(1);
    expect(report.gates.duplicateFalsePositives).toBe(0);
    expect(report.decision).toBe("GO");
    expect(report.live).toBe(false);
    expect(report.cases.every((row) => row.costUsd == null && row.latencyMs == null && row.attempts === 1)).toBe(true);
  });

  it("sums cost and latency across attempts and prints the attempt count", async () => {
    const casesDir = mkdtempSync(path.join(tmpdir(), "triage-case-"));
    const outputDir = mkdtempSync(path.join(tmpdir(), "triage-live-"));
    writeFileSync(
      path.join(casesDir, "02-checkout-down.json"),
      JSON.stringify({
        id: "02-checkout-down",
        input: { text: "Checkout does nothing." },
        expected: { category: "checkout", severity: "S1", duplicate_of: null },
        forbidden: [],
        fixture: {
          category: "checkout",
          severity: "S1",
          summary: "Checkout is down.",
          steps_to_reproduce: ["Pay"],
          suspected_area: "src/lib/checkout.ts",
          duplicate_of: null,
          duplicate_confidence: 0,
          screenshot_findings: null,
          pii_found: [],
          redacted_text: "Checkout does nothing.",
          confidence: 0.9,
          needs_human: false,
        },
      }),
    );
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return Response.json({
            choices: [{ message: { content: "not json" } }],
            usage: { prompt_tokens: 600, completion_tokens: 10 },
          });
        }
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            category: "checkout",
            severity: "S1",
            summary: "Checkout is down.",
            steps_to_reproduce: ["Pay"],
            suspected_area: "src/lib/checkout.ts",
            duplicate_of: null,
            duplicate_confidence: 0,
            screenshot_findings: null,
            pii_found: [],
            redacted_text: "Checkout does nothing.",
            confidence: 0.9,
            needs_human: false,
          }) } }],
          usage: { prompt_tokens: 600, completion_tokens: 20 },
        });
      }),
    );
    process.env.XAI_API_KEY = "eval-live-test-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const report = await runTriageEval({
      casesDir,
      outputDir,
      live: true,
      testsDir: path.join(process.cwd(), "tests"),
      testResultPath: path.join(process.cwd(), "evals/samples/vitest-green.json"),
      quiet: true,
    });
    delete process.env.XAI_API_KEY;
    const row = report.cases[0];
    expect(row?.attempts).toBe(2);
    expect(row?.latencyMs).toEqual(expect.any(Number));
    expect(row?.costUsd).toBeCloseTo((1200 * 1.25 + 30 * 2.5) / 1_000_000);
    printScorecard(report);
    const text = log.mock.calls.flat().map(String).join("\n");
    expect(text).toContain("attempts");
    expect(text).toContain("0.001575");
    log.mockRestore();
    vi.unstubAllGlobals();
  });

  it("flags leaked PII in a labelled output", () => {
    const scored = scoreLabels({
      id: "leak",
      expected: { category: "cart", severity: "S2", duplicate_of: null },
      output: {
        category: "cart",
        severity: "S2",
        summary: "Email shopper@example.com",
        steps_to_reproduce: [],
        suspected_area: "src/lib/cart.ts",
        duplicate_of: null,
        duplicate_confidence: 0,
        screenshot_findings: null,
        pii_found: [],
        redacted_text: "ok",
        confidence: 1,
        needs_human: false,
      },
      forbidden: ["shopper@example.com"],
    });
    expect(scored.schemaValid).toBe(true);
    expect(scored.piiLeaks.length).toBeGreaterThan(0);
  });
});
