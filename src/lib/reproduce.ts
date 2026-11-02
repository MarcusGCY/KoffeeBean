import type { RunResult } from "@cursor/sdk";
import * as gh from "./github";

/** Failure text kept on the GitHub issue. The tail is the assertion. */
export const FAILURE_OUTPUT_MAX = 2000;

/** Job name whose failure means the reproduction test itself failed. */
export const REPRO_CHECK = "repro";
/** Install job. A failure here is not a reproduced bug. */
export const REPRO_SETUP_CHECK = "repro-setup";
/** Marker the repro job prints only when vitest exits non-zero. */
export const REPRO_FAILED = "REPRO_FAILED";

const REPRO_FILE = /^tests\/repro\/[A-Za-z0-9][A-Za-z0-9_-]*\.test\.ts$/;
const SECRET_ENV = [
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APPROVAL_SECRET",
] as const;

export const REPRO_MARKER = "beanbox-repro";
export const REPRO_PENDING_MARKER = "beanbox-repro-pending";

export type ReproduceResult =
  | { status: "reproduced"; testPath: string; branch: string; output: string; checkUrl: string }
  | { status: "passed"; testPath: string; branch: string; checkUrl: string }
  | { status: "no-test" }
  | { status: "error"; testPath?: string; branch?: string; checkUrl?: string; detail: string }
  | { status: "pending" };

export type PendingRepro = {
  title: string;
  summary: string;
  feedback: string;
  reportedBy: string;
  testPath: string;
  branch: string;
  startedAt: number;
};

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

/** Workflow trigger is any branch whose name contains this token. */
export function isTriageBranch(branch: string | undefined): boolean {
  const safe = safeBranch(branch);
  return Boolean(safe && safe.includes("beanbox-triage"));
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

export function pendingMarker(pending: PendingRepro): string {
  const json = Buffer.from(JSON.stringify(pending), "utf8").toString("base64");
  return `<!-- ${REPRO_PENDING_MARKER} ${json} -->`;
}

export function parsePending(body: string): PendingRepro | undefined {
  const match = body.match(/<!--\s*beanbox-repro-pending\s+([A-Za-z0-9+/=]+)\s*-->/);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Partial<PendingRepro>;
    const testPath = safeTestPath(parsed.testPath);
    const branch = safeBranch(parsed.branch);
    if (!testPath || !branch || typeof parsed.title !== "string" || typeof parsed.startedAt !== "number") {
      return undefined;
    }
    return {
      title: parsed.title,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      reportedBy: typeof parsed.reportedBy === "string" ? parsed.reportedBy : "",
      testPath,
      branch,
      startedAt: parsed.startedAt,
    };
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
 * Read the GitHub check for the triage branch. A reproduced bug is only the
 * `repro` job concluding failure after vitest itself failed (`REPRO_FAILED`).
 * Install and setup failures are `error`. An unfinished check is `pending`.
 */
export async function judgeRepro(
  testPath: string | undefined,
  branch: string | undefined,
): Promise<ReproduceResult> {
  const path = safeTestPath(testPath);
  const ref = safeBranch(branch);
  if (!path || !ref) return { status: "no-test" };
  if (!isTriageBranch(ref)) {
    return {
      status: "error",
      testPath: path,
      branch: ref,
      detail: "The branch name does not contain beanbox-triage, so the reproduction workflow did not run.",
    };
  }
  const source = await gh.getFile(path, ref);
  if (source == null || !source.trim()) return { status: "no-test" };

  const [repro, setup] = await Promise.all([
    gh.latestCheck(ref, REPRO_CHECK),
    gh.latestCheck(ref, REPRO_SETUP_CHECK),
  ]);
  if (!repro || repro.status !== "completed") {
    if (setup?.status === "completed" && setup.conclusion && setup.conclusion !== "success") {
      return {
        status: "error",
        testPath: path,
        branch: ref,
        checkUrl: setup.htmlUrl || undefined,
        detail: "The reproduction check errored before the test ran (install or setup).",
      };
    }
    return { status: "pending" };
  }
  if (repro.conclusion === "success") {
    return { status: "passed", testPath: path, branch: ref, checkUrl: repro.htmlUrl };
  }
  if (repro.conclusion === "failure" && repro.text.includes(REPRO_FAILED)) {
    return {
      status: "reproduced",
      testPath: path,
      branch: ref,
      checkUrl: repro.htmlUrl,
      output: trimFailureOutput(repro.text),
    };
  }
  return {
    status: "error",
    testPath: path,
    branch: ref,
    checkUrl: repro.htmlUrl || setup?.htmlUrl || undefined,
    detail: "The reproduction check errored before the test ran (install or setup).",
  };
}

export function reproducedIssueBody(input: {
  summary: string;
  testPath: string;
  branch: string;
  output: string;
  checkUrl: string;
  feedback: string;
  reportedBy: string;
}): string {
  const output = input.output.trim() ? input.output.trim() : "(no output)";
  return [
    input.summary.trim(),
    "",
    `**Reproduction:** \`${input.testPath}\` on \`${input.branch}\` failed in CI.`,
    input.checkUrl ? `**Check:** ${input.checkUrl}` : "",
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
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

export function cannotReproduceBody(input: {
  summary: string;
  feedback: string;
  reportedBy: string;
  reason: "no-test" | "passed" | "error";
  detail?: string;
  testPath?: string;
  branch?: string;
  checkUrl?: string;
}): string {
  const where = input.testPath
    ? `\`${input.testPath}\`${input.branch ? ` on \`${input.branch}\`` : ""}`
    : "";
  const detail = input.reason === "passed" && where
    ? `Triage added ${where}, but that test passed on main.`
    : input.reason === "error"
      ? (input.detail ?? "The reproduction check errored before the test ran (install or setup).")
      : "Triage did not produce a test that fails on main.";
  const lines = [
    input.summary.trim(),
    "",
    `${detail} This report was not reproduced, so it is not waiting for review.`,
  ];
  if (input.checkUrl) lines.push("", `**Check:** ${input.checkUrl}`);
  lines.push(
    "",
    "---",
    "**Original report:**",
    `> ${input.feedback}`,
    "",
    input.reportedBy,
  );
  return lines.join("\n");
}

export function pendingIssueBody(pending: PendingRepro): string {
  return [
    `Waiting for the reproduction check on \`${pending.branch}\` (\`${pending.testPath}\`).`,
    "",
    pending.reportedBy,
    "",
    pendingMarker(pending),
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
