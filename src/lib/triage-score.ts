import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ClassifyOutput, type ClassifyOutput as Output } from "@/lib/triage-classify";
import { redactText } from "@/lib/triage-redact";
import { testSkips } from "@/lib/reproduce";

export const SEVERITY_RANK = { S1: 1, S2: 2, S3: 3, S4: 4 } as const;

export type Severity = keyof typeof SEVERITY_RANK;

export type SuiteReport = {
  success?: boolean;
  numFailedTests?: number;
  numFailedTestSuites?: number;
  testResults?: {
    name?: string;
    status?: string;
    assertionResults?: { status?: string }[];
  }[];
};

export type ScoredCase = {
  id: string;
  schemaValid: boolean;
  categoryMatch: boolean;
  severityExact: boolean;
  severityDistance: number;
  expectedDuplicate: number | null;
  predictedDuplicate: number | null;
  piiLeaks: string[];
  error: boolean;
};

export function severityDistance(expected: string, actual: string): number {
  const left = SEVERITY_RANK[expected as Severity];
  const right = SEVERITY_RANK[actual as Severity];
  if (!left || !right) return 99;
  return Math.abs(left - right);
}

export function scoreLabels(input: {
  id: string;
  expected: { category: string; severity: string; duplicate_of: number | null };
  output: unknown;
  forbidden: string[];
}): ScoredCase {
  const parsed = ClassifyOutput.safeParse(input.output);
  if (!parsed.success) return unscored(input, false);
  const output = parsed.data;
  if (output.fallback === true || output.category == null || output.severity == null) return unscored(input, true);
  return {
    id: input.id,
    schemaValid: true,
    categoryMatch: output.category === input.expected.category,
    severityExact: output.severity === input.expected.severity,
    severityDistance: severityDistance(input.expected.severity, output.severity),
    expectedDuplicate: input.expected.duplicate_of,
    predictedDuplicate: output.duplicate_of,
    piiLeaks: leaks(output, input.forbidden),
    error: false,
  };
}

function unscored(
  input: { id: string; expected: { duplicate_of: number | null }; output: unknown; forbidden: string[] },
  schemaValid: boolean,
): ScoredCase {
  return {
    id: input.id,
    schemaValid,
    categoryMatch: false,
    severityExact: false,
    severityDistance: 0,
    expectedDuplicate: input.expected.duplicate_of,
    predictedDuplicate: null,
    piiLeaks: leaks(input.output, input.forbidden),
    error: true,
  };
}

function scoredCases(cases: ScoredCase[]): ScoredCase[] {
  return cases.filter((row) => !row.error && row.schemaValid);
}

export function categoryAccuracy(cases: ScoredCase[]): number {
  const scored = scoredCases(cases);
  if (!scored.length) return 0;
  return scored.filter((row) => row.categoryMatch).length / scored.length;
}

export function severityExactRate(cases: ScoredCase[]): number {
  const scored = scoredCases(cases);
  if (!scored.length) return 0;
  return scored.filter((row) => row.severityExact).length / scored.length;
}

export function errorRate(cases: ScoredCase[]): number {
  if (!cases.length) return 0;
  return cases.filter((row) => row.error).length / cases.length;
}

/**
 * Share of cases with an expected duplicate id that returned that same id.
 * No such cases counts as 1. An error did not return the id, so it counts as a miss.
 */
export function duplicateRecall(cases: ScoredCase[]): number {
  const relevant = cases.filter((row) => row.expectedDuplicate != null);
  if (!relevant.length) return 1;
  const hits = relevant.filter((row) => !row.error && row.schemaValid && row.predictedDuplicate === row.expectedDuplicate);
  return hits.length / relevant.length;
}

/** Predicted duplicate ids that are not the expected id. */
export function duplicateFalsePositives(cases: ScoredCase[]): number {
  return cases.filter(
    (row) => !row.error && row.schemaValid && row.predictedDuplicate != null && row.predictedDuplicate !== row.expectedDuplicate,
  ).length;
}

/** Precision of predicted duplicates. No positive predictions counts as 1. */
export function duplicatePrecision(cases: ScoredCase[]): number {
  let tp = 0;
  let fp = 0;
  for (const row of cases) {
    if (row.error || !row.schemaValid || row.predictedDuplicate == null) continue;
    if (row.predictedDuplicate === row.expectedDuplicate) tp += 1;
    else fp += 1;
  }
  if (tp + fp === 0) return 1;
  return tp / (tp + fp);
}

export function outputStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(outputStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(outputStrings);
  return [];
}

export function leaks(value: unknown, forbidden: string[]): string[] {
  const texts = outputStrings(value);
  const found = new Set<string>();
  for (const text of texts) {
    for (const secret of forbidden) {
      if (secret && text.includes(secret)) found.add(secret);
    }
    if (redactText(text).types.length) found.add("pii-pattern");
  }
  return [...found];
}

export type ReproGate = { status: "na" | "pass" | "fail"; detail: string };

export function reproGate(base: SuiteReport | null, head: SuiteReport | null): ReproGate {
  if (!base && !head) return { status: "na", detail: "no base/head vitest reports" };
  if (!base || !head) return { status: "fail", detail: "both --base and --head are required" };
  if (!reproFailed(base)) return { status: "fail", detail: "repro did not fail on base" };
  if (!reproPassed(head)) return { status: "fail", detail: "repro did not pass on head" };
  return { status: "pass", detail: "repro fails on base and passes on head" };
}

function reproRows(report: SuiteReport) {
  return (report.testResults ?? []).filter((row) => (row.name ?? "").replaceAll("\\", "/").includes("tests/repro"));
}

function rowFailed(row: NonNullable<SuiteReport["testResults"]>[number]): boolean {
  if (row.status === "failed") return true;
  return Boolean(row.assertionResults?.some((item) => item.status === "failed"));
}

function reproFailed(report: SuiteReport): boolean {
  const rows = reproRows(report);
  if (rows.length) return rows.some(rowFailed);
  return report.success === false || (report.numFailedTests ?? 0) > 0;
}

function reproPassed(report: SuiteReport): boolean {
  const rows = reproRows(report);
  if (rows.length) return rows.every((row) => !rowFailed(row));
  return report.success === true || report.numFailedTests === 0;
}

export function suiteGreen(report: SuiteReport): boolean {
  if (report.success === true) return true;
  if (report.success === false) return false;
  return (report.numFailedTests ?? 1) === 0 && (report.numFailedTestSuites ?? 0) === 0;
}

/** Drop quoted strings, then reuse testSkips and also reject .only. */
export function hasSkippedOrWeakenedTest(source: string): boolean {
  const code = source
    .replace(/`(?:\\[\s\S]|[^`])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
  return testSkips(code) || /\.only\b/.test(code);
}

export function scanSkippedTests(root: string): string[] {
  const hits: string[] = [];
  walk(root, (file) => {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return;
    const source = readFileSync(file, "utf8");
    if (hasSkippedOrWeakenedTest(source)) hits.push(path.relative(root, file));
  });
  return hits;
}

function walk(dir: string, visit: (file: string) => void) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

export type GateReport = {
  schemaValid: boolean;
  piiClean: boolean;
  repro: ReproGate;
  skips: string[];
  testsGreen: boolean;
  categoryAccuracy: number;
  severityExact: number;
  maxSeverityDistance: number;
  duplicatePrecision: number;
  duplicateRecall: number;
  duplicateFalsePositives: number;
  errorCount: number;
  errorRate: number;
  decision: "GO" | "NO-GO";
};

export function decide(cases: ScoredCase[], gates: Omit<GateReport, "decision" | "categoryAccuracy" | "severityExact" | "maxSeverityDistance" | "duplicatePrecision" | "duplicateRecall" | "duplicateFalsePositives" | "errorCount" | "errorRate"> & {
  categoryAccuracy: number;
  severityExact: number;
  maxSeverityDistance: number;
  duplicatePrecision: number;
  errorCount: number;
  errorRate: number;
}): "GO" | "NO-GO" {
  const hard =
    gates.schemaValid &&
    gates.piiClean &&
    gates.repro.status !== "fail" &&
    gates.skips.length === 0 &&
    gates.testsGreen &&
    gates.errorRate === 0 &&
    gates.categoryAccuracy >= 0.9 &&
    gates.severityExact >= 0.8 &&
    gates.maxSeverityDistance <= 1 &&
    gates.duplicatePrecision >= 0.9 &&
    cases.length > 0;
  return hard ? "GO" : "NO-GO";
}

export function summarize(cases: ScoredCase[], extra: { repro: ReproGate; skips: string[]; testsGreen: boolean }): GateReport {
  const scored = cases.filter((row) => !row.error && row.schemaValid);
  const categoryAccuracyRate = categoryAccuracy(cases);
  const severityExact = severityExactRate(cases);
  const maxSeverityDistance = scored.reduce((max, row) => Math.max(max, row.severityDistance), 0);
  const precision = duplicatePrecision(cases);
  const recall = duplicateRecall(cases);
  const falsePositives = duplicateFalsePositives(cases);
  const errors = cases.filter((row) => row.error).length;
  const partial = {
    schemaValid: cases.length > 0 && cases.every((row) => row.schemaValid),
    piiClean: cases.every((row) => row.piiLeaks.length === 0),
    repro: extra.repro,
    skips: extra.skips,
    testsGreen: extra.testsGreen,
    categoryAccuracy: categoryAccuracyRate,
    severityExact,
    maxSeverityDistance,
    duplicatePrecision: precision,
    duplicateRecall: recall,
    duplicateFalsePositives: falsePositives,
    errorCount: errors,
    errorRate: errorRate(cases),
  };
  return { ...partial, decision: decide(cases, partial) };
}
