import { createHmac } from "node:crypto";
import type { RunResult } from "@cursor/sdk";
import { env } from "./env";
import * as gh from "./github";
import { safeEqual } from "./github-signature";

/** Failure text kept on the GitHub issue. The tail is the assertion. */
export const FAILURE_OUTPUT_MAX = 2000;

/** Job name of the workflow_dispatch repro run. */
export const REPRO_CHECK = "repro";

const REPRO_FILE = /^tests\/repro\/[A-Za-z0-9][A-Za-z0-9_-]*\.test\.ts$/;
const SHA = /^[0-9a-f]{40}$/;
const SECRET_ENV = [
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APPROVAL_SECRET",
  "CRON_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
  "DATABASE_URL",
] as const;

export const REPRO_MARKER = "beanbox-repro";
export const REPRO_PENDING_MARKER = "beanbox-repro-pending";

export type ReproduceResult =
  | { status: "reproduced"; testPath: string; branch: string; sha: string; output: string; checkUrl: string }
  | { status: "passed"; testPath: string; branch: string; sha: string; checkUrl: string }
  | { status: "no-test" }
  | { status: "error"; testPath?: string; branch?: string; sha?: string; checkUrl?: string; detail: string }
  | { status: "pending"; testPath: string; branch: string; sha: string };

export type PendingRepro = {
  title: string;
  summary: string;
  feedback: string;
  reportedBy: string;
  testPath: string;
  branch: string;
  sha: string;
  startedAt: number;
  quality?: {
    caseId: string;
    correlationId: string;
    severity: string | null;
    reason: string | null;
    category: string | null;
  };
  triageAgentId?: string;
  triageRunId?: string;
  intakeDelivery?: "delivered" | "skipped" | "failed";
};

type ReportKind =
  | { kind: "reproduced"; output: string }
  | { kind: "passed" }
  | { kind: "error"; detail: string };

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

export function safeSha(value: string | undefined): string | undefined {
  const sha = value?.trim().toLowerCase();
  if (!sha || !SHA.test(sha)) return undefined;
  return sha;
}

/** Workflows are dispatched only for branches whose name contains this token. */
export function isTriageBranch(branch: string | undefined): boolean {
  const safe = safeBranch(branch);
  return Boolean(safe && safe.includes("beanbox-triage"));
}

/** `tests/repro/<slug>.test.ts` → slug, lowercased. */
export function slugFromTestPath(testPath: string | undefined): string | undefined {
  const safe = safeTestPath(testPath);
  if (!safe) return undefined;
  const slug = safe.slice("tests/repro/".length, -".test.ts".length).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return undefined;
  return slug;
}

/** First 8 characters of a bc- or run id, after dropping characters outside [a-z0-9-]. */
export function shortRunId(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 8);
}

/** `beanbox-triage/<slug>-<short run id>`. The same inputs always return the same name. */
export function triageBranchName(slug: string, runId: string): string | undefined {
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const short = shortRunId(runId);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleanSlug) || !short) return undefined;
  return `beanbox-triage/${cleanSlug}-${short}`;
}

/** True only for the unique name. The bare `beanbox-triage/<slug>` does not match. */
export function isExactTriageBranch(branch: string | undefined, testPath: string | undefined): boolean {
  const ref = safeBranch(branch);
  const slug = slugFromTestPath(testPath);
  if (!ref || !slug) return false;
  const prefix = `beanbox-triage/${slug}-`;
  if (!ref.startsWith(prefix)) return false;
  return /^[a-z0-9-]{1,8}$/.test(ref.slice(prefix.length));
}

/** Why a triage diff is not one new repro file. Paths and SHAs only. */
export function reproDiffReason(input: {
  path: string;
  baseSha: string;
  behind: number;
  files: gh.ChangedFile[];
}): string | undefined {
  const reasons: string[] = [];
  if (input.behind > 0) reasons.push(`behind=${input.behind}`);
  const match = input.files.find((file) => file.filename === input.path);
  if (match && match.status !== "added") reasons.push(`file=${match.status} base=${input.baseSha} path=${input.path}`);
  if (input.files.length !== 1) reasons.push(`files=${input.files.length}`);
  if (reasons.length === 0 && !isSingleReproAdd(input.files, input.path)) reasons.push(`files=${input.files.length}`);
  if (isSingleReproAdd(input.files, input.path) && input.behind === 0) return undefined;
  return reasons.join(" ");
}

export function branchFromRun(result: RunResult): string | undefined {
  for (const item of result.git?.branches ?? []) {
    const branch = safeBranch(item.branch);
    if (branch) return branch;
  }
  return undefined;
}

/** The triage commit may add this one new test and nothing else. */
export function isSingleReproAdd(files: gh.ChangedFile[], testPath: string): boolean {
  if (files.length !== 1) return false;
  const [file] = files;
  return file.status === "added" && file.filename === testPath && safeTestPath(file.filename) === testPath;
}

function sign(payload: string): string {
  return createHmac("sha256", env("APPROVAL_SECRET")).update(payload).digest("hex");
}

export function reproMarker(testPath: string, branch: string, sha: string): string {
  const payload = JSON.stringify({ testPath, branch, sha });
  return `<!-- ${REPRO_MARKER} ${payload} ${sign(payload)} -->`;
}

/** First valid HMAC wins, so a marker forged into the summary cannot replace it. */
export function parseRepro(body: string): { testPath: string; branch: string; sha: string } | undefined {
  const re = /<!--\s*beanbox-repro\s+(\{[\s\S]*?\})\s+([0-9a-f]{64})\s*-->/gi;
  for (const match of body.matchAll(re)) {
    const payload = match[1];
    const sig = match[2];
    if (!payload || !sig || !safeEqual(sig, sign(payload))) continue;
    try {
      const parsed = JSON.parse(payload) as { testPath?: unknown; branch?: unknown; sha?: unknown };
      const testPath = safeTestPath(typeof parsed.testPath === "string" ? parsed.testPath : undefined);
      const branch = safeBranch(typeof parsed.branch === "string" ? parsed.branch : undefined);
      const sha = safeSha(typeof parsed.sha === "string" ? parsed.sha : undefined);
      if (!testPath || !branch || !sha) continue;
      return { testPath, branch, sha };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function pendingMarker(pending: PendingRepro): string {
  const encoded = Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
  return `<!-- ${REPRO_PENDING_MARKER} ${encoded}.${sign(encoded)} -->`;
}

export function parsePending(body: string): PendingRepro | undefined {
  const re = /<!--\s*beanbox-repro-pending\s+([A-Za-z0-9_-]+)\.([0-9a-f]{64})\s*-->/gi;
  for (const match of body.matchAll(re)) {
    const encoded = match[1];
    const sig = match[2];
    if (!encoded || !sig || !safeEqual(sig, sign(encoded))) continue;
    try {
      const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<PendingRepro>;
      const testPath = safeTestPath(parsed.testPath);
      const branch = safeBranch(parsed.branch);
      const sha = safeSha(parsed.sha);
      if (!testPath || !branch || !sha || typeof parsed.title !== "string" || typeof parsed.startedAt !== "number") {
        continue;
      }
      return {
        title: parsed.title,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
        reportedBy: typeof parsed.reportedBy === "string" ? parsed.reportedBy : "",
        testPath,
        branch,
        sha,
        startedAt: parsed.startedAt,
        ...(parsed.quality && typeof parsed.quality.caseId === "string" ? { quality: parsed.quality } : {}),
        ...(typeof parsed.triageAgentId === "string" ? { triageAgentId: parsed.triageAgentId } : {}),
        ...(typeof parsed.triageRunId === "string" ? { triageRunId: parsed.triageRunId } : {}),
        ...(parsed.intakeDelivery === "delivered" || parsed.intakeDelivery === "skipped" || parsed.intakeDelivery === "failed"
          ? { intakeDelivery: parsed.intakeDelivery }
          : {}),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function trimFailureOutput(text: string): string {
  const clean = redactSecrets(text).replace(/\u0000/g, "").replace(/```/g, "'''").trim();
  if (!clean) return "";
  if (clean.length <= FAILURE_OUTPUT_MAX) return clean;
  return `…${clean.slice(-FAILURE_OUTPUT_MAX)}`;
}

type Suite = {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: { status?: string; failureMessages?: string[] }[];
};

/** A reproduced bug is a failed assertion in that file, with no load error. */
export function interpretVitestReport(report: unknown, testPath: string): ReportKind {
  if (!report || typeof report !== "object") {
    return { kind: "error", detail: "The reproduction run did not report a vitest result." };
  }
  const record = report as { error?: unknown; testResults?: unknown };
  if (record.error) {
    return { kind: "error", detail: "The reproduction run could not collect the test." };
  }
  const results = Array.isArray(record.testResults) ? record.testResults as Suite[] : [];
  const file = results.filter((suite) => typeof suite?.name === "string" && (suite.name === testPath || suite.name.endsWith(`/${testPath}`)));
  if (file.length === 0) {
    return { kind: "error", detail: "The reproduction run found no tests." };
  }
  for (const suite of file) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    const message = typeof suite.message === "string" ? suite.message.trim() : "";
    if (assertions.length === 0 && (message || suite.status === "failed")) {
      return { kind: "error", detail: "The reproduction test failed to load (collection, import, or syntax error)." };
    }
  }
  const failed = file.flatMap((suite) => (suite.assertionResults ?? []).filter((item) => item.status === "failed"));
  if (failed.length > 0) {
    const output = failed.flatMap((item) => item.failureMessages ?? []).join("\n");
    return { kind: "reproduced", output: trimFailureOutput(output) };
  }
  const passed = file.some((suite) => (suite.assertionResults ?? []).some((item) => item.status === "passed"));
  if (passed) return { kind: "passed" };
  return { kind: "error", detail: "The reproduction run found no failed assertion." };
}

export function interpretReproLog(log: string, testPath: string): ReportKind {
  const matches = [...log.matchAll(/REPRO_RESULT (\{.*\})/g)];
  const last = matches.at(-1);
  if (!last?.[1]) return { kind: "error", detail: "The reproduction run did not report a vitest result." };
  try {
    return interpretVitestReport(JSON.parse(last[1]), testPath);
  } catch {
    return { kind: "error", detail: "The reproduction run did not report a vitest result." };
  }
}

/**
 * Resolve the triage branch to a sha, require a one-file diff, and read the
 * workflow_dispatch run started from main for that sha. The workflow file
 * on the triage branch is never executed.
 */
export async function judgeRepro(
  testPath: string | undefined,
  branch: string | undefined,
  opts?: { sha?: string; dispatch?: boolean },
): Promise<ReproduceResult> {
  const path = safeTestPath(testPath);
  const ref = safeBranch(branch);
  if (!path || !ref || !isExactTriageBranch(ref, path)) {
    console.log(`[triage] no-test reason=branch=missing name=${ref ?? ""}`);
    return { status: "no-test" };
  }
  const sha = safeSha(opts?.sha) ?? await gh.branchSha(ref);
  if (!sha) {
    console.log(`[triage] no-test reason=branch=missing name=${ref}`);
    return { status: "no-test" };
  }
  const source = await gh.getFile(path, sha);
  if (source == null || !source.trim()) {
    console.log(`[triage] no-test reason=file=missing path=${path}`);
    return { status: "no-test" };
  }
  const compared = await gh.compareAgainstMain(ref);
  if (!compared) {
    console.log(`[triage] no-test reason=branch=missing name=${ref}`);
    return { status: "no-test" };
  }
  const reason = reproDiffReason({
    path,
    baseSha: compared.baseSha,
    behind: compared.behind,
    files: compared.files,
  });
  if (reason) {
    console.log(`[triage] no-test reason=${reason}`);
    const modified = compared.files.some((file) => file.filename === path && file.status !== "added");
    if (compared.behind > 0 || modified) return { status: "no-test" };
    return {
      status: "error",
      testPath: path,
      branch: ref,
      sha,
      detail: "The triage commit changes more than the one reproduction test.",
    };
  }

  const run = await gh.findReproRun(sha, path);
  if (!run) {
    if (opts?.dispatch) await gh.dispatchRepro(path, sha);
    return { status: "pending", testPath: path, branch: ref, sha };
  }
  if (run.status !== "completed") return { status: "pending", testPath: path, branch: ref, sha };
  const report = interpretReproLog(await gh.workflowRunLog(run.id), path);
  if (report.kind === "reproduced") {
    return { status: "reproduced", testPath: path, branch: ref, sha, output: report.output, checkUrl: run.htmlUrl };
  }
  if (report.kind === "passed") return { status: "passed", testPath: path, branch: ref, sha, checkUrl: run.htmlUrl };
  return { status: "error", testPath: path, branch: ref, sha, checkUrl: run.htmlUrl, detail: report.detail };
}

export function reproducedIssueBody(input: {
  summary: string;
  testPath: string;
  branch: string;
  sha: string;
  output: string;
  checkUrl: string;
  feedback: string;
  reportedBy: string;
}): string {
  const output = input.output.trim() ? input.output.trim() : "(no output)";
  return [
    reproMarker(input.testPath, input.branch, input.sha),
    "",
    input.summary.trim(),
    "",
    `**Reproduction:** \`${input.testPath}\` at \`${input.sha}\` failed in CI.`,
    input.checkUrl ? `**Check:** ${input.checkUrl}` : "",
    "",
    "```",
    output,
    "```",
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
  lines.push("", "---", "**Original report:**", `> ${input.feedback}`, "", input.reportedBy);
  return lines.join("\n");
}

export function pendingIssueBody(pending: PendingRepro): string {
  return [
    pendingMarker(pending),
    "",
    `Waiting for the reproduction check on \`${pending.branch}\` (\`${pending.testPath}\`) at \`${pending.sha}\`.`,
    "",
    pending.reportedBy,
  ].join("\n");
}

/** True when the fix copy skips the reproduction test. */
export function testSkips(source: string): boolean {
  return /\.(?:skip|skipIf|todo)\b/.test(source);
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
