import type { RunResult } from "@cursor/sdk";
import * as gh from "./github";
import { runTestOnMain } from "./run-test";

/** Failure text kept on the GitHub issue. The tail is the assertion. */
export const FAILURE_OUTPUT_MAX = 2000;

const REPRO_FILE = /^tests\/repro\/[A-Za-z0-9][A-Za-z0-9_-]*\.test\.ts$/;
const SECRET_ENV = [
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APPROVAL_SECRET",
] as const;

export const REPRO_MARKER = "beanbox-repro";

export type ReproduceResult =
  | { reproduced: true; testPath: string; branch: string; output: string }
  | { reproduced: false; reason: "no-test" | "passed"; testPath?: string; branch?: string };

export function safeTestPath(value: string | undefined): string | undefined {
  const testPath = value?.trim();
  if (!testPath || !REPRO_FILE.test(testPath)) return undefined;
  return testPath;
}

export function safeBranch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const branch = value.trim().replace(/^refs\/heads\//, "");
  if (!branch || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return undefined;
  return branch;
}

export function branchFromRun(result: RunResult): string | undefined {
  for (const item of result.git?.branches ?? []) {
    const branch = safeBranch(item.branch);
    if (branch) return branch;
  }
  return undefined;
}

export function reproMarker(testPath: string, branch: string): string {
  return `<!-- ${REPRO_MARKER} ${JSON.stringify({ testPath, branch })} -->`;
}

export function parseRepro(body: string): { testPath: string; branch?: string } | undefined {
  const match = body.match(/<!--\s*beanbox-repro\s+(\{[\s\S]*?\})\s*-->/);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { testPath?: unknown; branch?: unknown };
    const testPath = safeTestPath(typeof parsed.testPath === "string" ? parsed.testPath : undefined);
    if (!testPath) return undefined;
    const branch = safeBranch(typeof parsed.branch === "string" ? parsed.branch : undefined);
    return branch ? { testPath, branch } : { testPath };
  } catch {
    return undefined;
  }
}

export function trimFailureOutput(text: string): string {
  const clean = redactSecrets(text).replace(/\u0000/g, "").replace(/```/g, "'''").trim();
  if (!clean) return "";
  if (clean.length <= FAILURE_OUTPUT_MAX) return clean;
  return `…${clean.slice(-FAILURE_OUTPUT_MAX)}`;
}

/**
 * Fetch the triage branch's test and run it against this checkout of main.
 * A non-zero vitest exit means the report was reproduced.
 */
export async function reproduceOnMain(
  testPath: string | undefined,
  branch: string | undefined,
): Promise<ReproduceResult> {
  const path = safeTestPath(testPath);
  const ref = safeBranch(branch);
  if (!path || !ref) return { reproduced: false, reason: "no-test" };
  const source = await gh.getFile(path, ref);
  if (source == null || !source.trim()) return { reproduced: false, reason: "no-test", testPath: path, branch: ref };
  const run = await runTestOnMain(source);
  if (run.code === 0) return { reproduced: false, reason: "passed", testPath: path, branch: ref };
  return { reproduced: true, testPath: path, branch: ref, output: trimFailureOutput(run.output) };
}

export function reproducedIssueBody(input: {
  summary: string;
  testPath: string;
  branch: string;
  output: string;
  feedback: string;
  reportedBy: string;
}): string {
  const output = input.output.trim() ? input.output.trim() : "(no output)";
  return [
    input.summary.trim(),
    "",
    `**Reproduction:** \`${input.testPath}\` on \`${input.branch}\` fails against main.`,
    "",
    "```",
    output,
    "```",
    "",
    reproMarker(input.testPath, input.branch),
    "",
    "---",
    "**Original report:**",
    `> ${input.feedback}`,
    "",
    input.reportedBy,
  ].join("\n");
}

export function cannotReproduceBody(input: {
  summary: string;
  feedback: string;
  reportedBy: string;
  reason: "no-test" | "passed";
  testPath?: string;
  branch?: string;
}): string {
  const where = input.testPath
    ? `\`${input.testPath}\`${input.branch ? ` on \`${input.branch}\`` : ""}`
    : "";
  const detail = input.reason === "passed" && where
    ? `Triage added ${where}, but that test passed on main.`
    : "Triage did not produce a test that fails on main.";
  return [
    input.summary.trim(),
    "",
    `${detail} This report was not reproduced, so it is not waiting for review.`,
    "",
    "---",
    "**Original report:**",
    `> ${input.feedback}`,
    "",
    input.reportedBy,
  ].join("\n");
}

function redactSecrets(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const secret = process.env[name];
    if (!secret || secret.length < 8 || !out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
