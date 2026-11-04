import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyFeedback, DEFAULT_TRIAGE_GROK_MODEL, type ClassifyInput } from "@/lib/triage-classify";

/** Same published rate as grok-4.20-0309-non-reasoning under 200k tokens. */
const INPUT_PER_M = 1.25;
const OUTPUT_PER_M = 2.5;
import {
  reproGate,
  scanSkippedTests,
  scoreLabels,
  suiteGreen,
  summarize,
  type ScoredCase,
  type SuiteReport,
} from "@/lib/triage-score";

export type EvalCaseFile = {
  id: string;
  input: ClassifyInput & { screenshot?: string; candidates?: ClassifyInput["candidates"] };
  expected: { category: string; severity: string; duplicate_of: number | null };
  forbidden?: string[];
  fixture: unknown;
};

export type CaseRow = ScoredCase & {
  latencyMs?: number;
  costUsd?: number | null;
};

export type EvalReport = {
  generatedAt: string;
  live: boolean;
  model: string;
  decision: "GO" | "NO-GO";
  gates: ReturnType<typeof summarize>;
  cases: CaseRow[];
};

export async function runTriageEval(options: {
  casesDir: string;
  live?: boolean;
  basePath?: string;
  headPath?: string;
  testResultPath?: string;
  outputDir: string;
  testsDir?: string;
  cwd?: string;
  quiet?: boolean;
}): Promise<EvalReport> {
  const live = Boolean(options.live);
  const cases = loadCases(options.casesDir);
  const rows: CaseRow[] = [];
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.XAI_API_KEY;
  if (!live && !process.env.XAI_API_KEY?.trim()) process.env.XAI_API_KEY = "eval-mock-key";
  try {
    for (const item of cases) {
      const started = Date.now();
      const seen: { prompt_tokens: number; completion_tokens: number } = { prompt_tokens: 0, completion_tokens: 0 };
      let sawUsage = false;
      const inner = live ? previousFetch : mockFetch(item.fixture);
      globalThis.fetch = observeUsage(inner, () => {
        sawUsage = true;
      }, seen);
      let output: unknown;
      try {
        output = await classifyFeedback({
          text: item.input.text,
          screenshot: item.input.screenshot,
          candidates: item.input.candidates ?? [],
        });
      } catch {
        output = null;
      }
      const scored = scoreLabels({
        id: item.id,
        expected: item.expected,
        output,
        forbidden: item.forbidden ?? [],
      });
      const latencyMs = Date.now() - started;
      const costUsd = live && sawUsage
        ? (seen.prompt_tokens * INPUT_PER_M + seen.completion_tokens * OUTPUT_PER_M) / 1_000_000
        : null;
      rows.push({
        ...scored,
        ...(live ? { latencyMs, costUsd } : {}),
      });
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }

  const base = options.basePath ? readReport(options.basePath) : null;
  const head = options.headPath ? readReport(options.headPath) : null;
  const testsGreen = options.testResultPath ? suiteGreen(readReport(options.testResultPath)) : runNpmTest(options.cwd ?? process.cwd()) === 0;
  const gates = summarize(rows, {
    repro: reproGate(base, head),
    skips: scanSkippedTests(options.testsDir ?? path.join(options.cwd ?? process.cwd(), "tests")),
    testsGreen,
  });
  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    live,
    model: process.env.TRIAGE_GROK_MODEL?.trim() || DEFAULT_TRIAGE_GROK_MODEL,
    decision: gates.decision,
    gates,
    cases: rows,
  };
  mkdirSync(options.outputDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  writeFileSync(path.join(options.outputDir, `triage-${stamp}.json`), JSON.stringify(report, null, 2));
  writeFileSync(path.join(options.outputDir, "latest.json"), JSON.stringify(report, null, 2));
  if (!options.quiet) printScorecard(report);
  return report;
}

function loadCases(dir: string): EvalCaseFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as EvalCaseFile);
}

function readReport(file: string): SuiteReport {
  return JSON.parse(readFileSync(file, "utf8")) as SuiteReport;
}

function mockFetch(fixture: unknown): typeof fetch {
  const content = JSON.stringify(fixture);
  return (async () =>
    Response.json({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    })) as typeof fetch;
}

function observeUsage(
  inner: typeof fetch,
  note: () => void,
  seen: { prompt_tokens: number; completion_tokens: number },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init);
    try {
      const payload = (await response.clone().json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (payload.usage) {
        seen.prompt_tokens += payload.usage.prompt_tokens ?? 0;
        seen.completion_tokens += payload.usage.completion_tokens ?? 0;
        note();
      }
    } catch {
      // Error bodies are not usage JSON.
    }
    return response;
  }) as typeof fetch;
}

function runNpmTest(cwd: string): number {
  const result = spawnSync("npm", ["test"], { cwd, stdio: "inherit" });
  return result.status ?? 1;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function printScorecard(report: EvalReport) {
  const headers = ["case", "category", "severity", "dup", "schema", "pii"];
  const body = report.cases.map((row) => [
    row.id,
    row.categoryMatch ? "ok" : "miss",
    row.severityExact ? "exact" : `off ${row.severityDistance}`,
    row.predictedDuplicate == null ? "none" : `#${row.predictedDuplicate}`,
    row.schemaValid ? "ok" : "bad",
    row.piiLeaks.length ? "LEAK" : "ok",
  ]);
  if (report.live) {
    headers.push("ms", "cost");
    body.forEach((cells, index) => {
      const row = report.cases[index];
      cells.push(String(row?.latencyMs ?? ""), row?.costUsd == null ? "" : row.costUsd.toFixed(6));
    });
  }
  const widths = headers.map((header, index) => Math.max(header.length, ...body.map((cells) => cells[index]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const cells of body) console.log(line(cells));
  const gates = report.gates;
  console.log("");
  console.log(`category ${pct(gates.categoryAccuracy)} (target 90%)`);
  console.log(`severity exact ${pct(gates.severityExact)} (target 80%), max off ${gates.maxSeverityDistance}`);
  console.log(`duplicate precision ${pct(gates.duplicatePrecision)} (target 90%)`);
  console.log(`schema ${gates.schemaValid ? "100%" : "FAIL"}  pii ${gates.piiClean ? "clean" : "LEAK"}`);
  console.log(`repro before/after: ${gates.repro.status} (${gates.repro.detail})`);
  console.log(`skipped tests: ${gates.skips.length ? gates.skips.join(", ") : "none"}`);
  console.log(`npm test: ${gates.testsGreen ? "green" : "FAIL"}`);
  console.log(report.decision);
}
