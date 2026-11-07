import { Agent, type ModelSelection, type Run, type RunResult } from "@cursor/sdk";
import { z } from "zod";
import { resolveCursorModel } from "./agent-model";
import { env, repo } from "./env";
import type { OpenIssue } from "./github";
import { safeTestPath, shortRunId, slugFromTestPath, triageBranchName } from "./reproduce";
import { followRun, readFinalAssistantText, reconcileRunResult, serverlessTrackBudgetMs } from "./run-status";

const Decision = z.object({
  action: z.enum(["create", "merge"]),
  issueNumber: z.number().int().optional(),
  title: z.string(),
  body: z.string(),
  testPath: z.string().optional(),
  branch: z.string().optional(),
});
export type Decision = z.infer<typeof Decision> & {
  branch?: string;
  agentId?: string;
  runId?: string;
};

const PREVIEW_MAX = 160;

// Triage runs on every feedback submission and is tightly constrained
// (one failing test, single-file check), so it uses a cheap model.
const TRIAGE_MODEL: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/**
 * Ask a Cursor agent to decide whether a feedback report duplicates an open
 * issue. A new bug is a failing vitest file pushed on a beanbox-triage branch.
 * GitHub Actions runs that file; the server reads the check before opening an issue.
 *
 * wait() can report a false error or hang when the run is launched from
 * Next.js after(). reconcileRunResult confirms the terminal status first.
 */
export async function triageFeedback(
  feedback: string,
  open: OpenIssue[],
): Promise<Decision> {
  const apiKey = env("CURSOR_API_KEY");
  const startedAt = Date.now();
  const model = await resolveCursorModel({
    kind: "triage",
    envName: "TRIAGE_MODEL",
    fallback: TRIAGE_MODEL,
    apiKey,
  });
  const agent = await Agent.create({
    apiKey,
    model,
    // Parallel reports must not share one cloud agent name.
    name: `beanbox-triage-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    mode: "agent",
    cloud: {
      repos: [{ url: repo().url, startingRef: "main" }],
      autoCreatePR: false,
    },
  });
  try {
    const run = await agent.send(prompt(feedback, open, shortRunId(agent.agentId)));
    console.log(`[triage] agent=${agent.agentId} run=${run.id}`);
    const result = await trackTriageRun(run, apiKey, open);
    if (result.status !== "finished") throw triageRunError(result);
    return parseDecision(result.result, open, result, {
      startedAt,
      runId: run.id,
      agentId: agent.agentId,
    });
  } finally {
    agent.close();
  }
}

/**
 * Local dev can wait out a slow plan run. On Vercel, `wait()` can hang for
 * the rest of maxDuration and the platform then kills the isolate, so triage
 * polls getRun inside the serverless budget. A finished getRun snapshot often
 * has no assistant reply; `conversation()` replays that one finished run.
 */
async function trackTriageRun(run: Run, apiKey: string, open: OpenIssue[]): Promise<RunResult> {
  const usable = (text: string | undefined) => Boolean(firstDecision(text, open));
  if (process.env.VERCEL === "1") {
    const outcome = await followRun(run, apiKey, serverlessTrackBudgetMs());
    if (!outcome.done) {
      throw new Error(
        `Triage run still ${outcome.lastStatus ?? "unconfirmed"} after ${serverlessTrackBudgetMs()}ms`,
      );
    }
    return hydrateReply(outcome.run, outcome.result, usable);
  }
  const result = await reconcileRunResult(run, apiKey);
  return hydrateReply(run, result, usable);
}

/**
 * `wait()` already stored the SSE reply on the live handle. `getRun` often
 * does not: its REST `result` is empty while `conversation()` replays the
 * stream and surfaces that reply. Skip the replay when the text we have
 * already parses as a decision, so a finished local run does not stream again.
 */
async function hydrateReply(
  run: Run,
  snapshot: RunResult,
  usable: (text: string | undefined) => boolean,
): Promise<RunResult> {
  if (snapshot.status !== "finished" || usable(snapshot.result)) return snapshot;
  const text = await readFinalAssistantText(run, { accept: usable });
  return text ? { ...snapshot, result: text } : snapshot;
}

function prompt(feedback: string, open: OpenIssue[], suffix: string): string {
  const branch = suffix ? `beanbox-triage/<slug>-${suffix}` : "beanbox-triage/<slug>-<8 character run id>";
  return [
    "You triage BeanBox feedback. Follow .cursor/rules/triage.mdc.",
    "Hard rules: create or merge; exactly one failing test at tests/repro/<slug>.test.ts; no edits under src/ and no workflow edits.",
    `The branch name is exactly \`${branch}\`. Run \`git fetch origin main\` and create that branch from the latest origin/main.`,
    "Never reuse or check out an existing branch. Push only to that name.",
    "Use the write-repro-test and pre-pr-self-check skills (.cursor/skills/write-repro-test/SKILL.md and .cursor/skills/pre-pr-self-check/SKILL.md).",
    "",
    `## New feedback\n${feedback}`,
    "",
    `## Open issues\n${open.length ? open.map((i) => `#${i.number} ${i.title}\n${i.body.slice(0, 400)}`).join("\n\n") : "(none)"}`,
    "",
    "As your final answer, put one JSON object in a markdown json fenced code block:",
    "```json",
    `{"action":"merge"|"create","issueNumber":<n, merge only>,"title":"<short bug title>","body":"<markdown: summary, steps to reproduce, suspected file/root cause>","testPath":"tests/repro/<slug>.test.ts","branch":"${branch}"}`,
    "```",
  ].join("\n");
}

function parseDecision(
  text: string | undefined,
  open: OpenIssue[],
  result: RunResult,
  ctx: { startedAt: number; runId: string; agentId: string },
): Promise<Decision> {
  const parsed = firstDecision(text, open);
  if (parsed) return resolveRepro(parsed, result, ctx);
  const preview = previewResult(text);
  const received = preview ? JSON.stringify(preview) : '"(empty)"';
  throw new Error(
    `Triage returned no JSON runId=${result.id || "unknown"} status=${result.status} received=${received}`,
  );
}

/** Fenced JSON first, then the outermost object. A wrapping note can contain braces. */
function firstDecision(text: string | undefined, open: OpenIssue[]): Decision | undefined {
  if (!text) return undefined;
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = match[1]?.match(/\{[\s\S]*\}/)?.[0];
    if (inner) candidates.push(inner);
  }
  const greedy = text.match(/\{[\s\S]*\}/)?.[0];
  if (greedy) candidates.push(greedy);
  for (const json of candidates) {
    try {
      const d = Decision.parse(JSON.parse(json));
      if (d.action === "merge" && !open.some((i) => i.number === d.issueNumber)) {
        return { ...d, action: "create", issueNumber: undefined };
      }
      return d;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function resolveRepro(
  d: Decision,
  result: RunResult,
  ctx: { startedAt: number; runId: string; agentId: string },
): Promise<Decision> {
  const id = ctx.agentId.trim() || ctx.runId.trim();
  let testPath = safeTestPath(d.testPath);
  if (!testPath) {
    const slug = slugFromReportedBranch(d.branch, id);
    if (slug) testPath = `tests/repro/${slug}.test.ts`;
  }
  const slug = slugFromTestPath(testPath);
  const branch = slug ? triageBranchName(slug, id) : undefined;

  console.log(`[triage] decision testPath=${testPath ? "ok" : "missing"} branch=${branch ? "ok" : "missing"}`);

  const next: Decision = { ...d, agentId: ctx.agentId, runId: ctx.runId };
  if (testPath) next.testPath = testPath;
  else delete next.testPath;
  if (branch) next.branch = branch;
  else delete next.branch;
  return next;
}

/** Slug encoded in `beanbox-triage/<slug>-<this run's short id>`, never a bare slug. */
function slugFromReportedBranch(branch: string | undefined, runId: string): string | undefined {
  const short = shortRunId(runId);
  const safe = branch?.trim().replace(/^refs\/heads\//, "");
  if (!safe || !short || !safe.startsWith("beanbox-triage/") || !safe.endsWith(`-${short}`)) return undefined;
  const slug = safe.slice("beanbox-triage/".length, -(`-${short}`.length));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return undefined;
  return slug;
}

function triageRunError(result: RunResult): Error {
  const requestId = result.requestId || result.id || "unknown";
  const duration = result.durationMs ?? "unknown";
  const preview = previewResult(result.result);
  const errorPreview = previewResult(result.error?.message);
  const parts = [
    `Triage run ${result.status}`,
    `durationMs=${duration}`,
    `requestId=${requestId}`,
  ];
  if (errorPreview) parts.push(`error=${JSON.stringify(errorPreview)}`);
  if (result.error?.code) parts.push(`code=${result.error.code}`);
  if (preview) parts.push(`result=${JSON.stringify(preview)}`);
  return new Error(parts.join(" "));
}

function previewResult(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const compact = redactSecrets(text).replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (compact.length <= PREVIEW_MAX) return compact;
  return `${compact.slice(0, PREVIEW_MAX)}...`;
}

function redactSecrets(text: string): string {
  const secret = process.env.CURSOR_API_KEY;
  if (!secret || secret.length < 8 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}
