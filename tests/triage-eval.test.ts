import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTriageEval } from "@/lib/triage-eval";
import {
  categoryAccuracy,
  decide,
  duplicatePrecision,
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
    expect(report.decision).toBe("GO");
    expect(report.live).toBe(false);
    expect(report.cases.every((row) => row.costUsd == null && row.latencyMs == null)).toBe(true);
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
