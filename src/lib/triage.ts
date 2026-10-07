import { Agent, type RunResult } from "@cursor/sdk";
import { z } from "zod";
import { env, repo } from "./env";
import type { OpenIssue } from "./github";
import { reconcileRunResult } from "./run-status";

const Decision = z.object({
  action: z.enum(["create", "merge"]),
  issueNumber: z.number().int().optional(),
  title: z.string(),
  body: z.string(),
});
export type Decision = z.infer<typeof Decision>;

const PREVIEW_MAX = 160;

/**
 * Ask a Cursor agent (read-only "plan" mode) to decide whether a feedback
 * report duplicates an open issue, and to draft the issue text if it doesn't.
 *
 * wait() can report a false error or hang when the run is launched from
 * Next.js after(). reconcileRunResult confirms the terminal status first.
 */
export async function triageFeedback(
  feedback: string,
  open: OpenIssue[],
): Promise<Decision> {
  const apiKey = env("CURSOR_API_KEY");
  const agent = await Agent.create({
    apiKey,
    // Parallel reports must not share one cloud agent name.
    name: `beanbox-triage-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    mode: "plan",
    cloud: { repos: [{ url: repo().url }], autoCreatePR: false },
  });
  try {
    const run = await agent.send(prompt(feedback, open));
    console.log(`[triage] agent=${agent.agentId} run=${run.id}`);
    const result = await reconcileRunResult(run, apiKey);
    if (result.status !== "finished") throw triageRunError(result);
    return parseDecision(result.result, open);
  } finally {
    agent.close();
  }
}

function prompt(feedback: string, open: OpenIssue[]): string {
  return [
    "You triage user feedback for the BeanBox online store (Next.js, code in src/lib and src/components).",
    "Decide if the feedback describes the SAME underlying bug as one of the open issues below.",
    "Look at the code if needed to find the real root cause; different wording can be one bug.",
    "",
    `## New feedback\n${feedback}`,
    "",
    `## Open issues\n${open.length ? open.map((i) => `#${i.number} ${i.title}\n${i.body.slice(0, 400)}`).join("\n\n") : "(none)"}`,
    "",
    "As your final answer, put one JSON object in a markdown json fenced code block:",
    "```json",
    '{"action":"merge"|"create","issueNumber":<n, merge only>,"title":"<short bug title>","body":"<markdown: summary, steps to reproduce, suspected file/root cause>"}',
    "```",
  ].join("\n");
}

function parseDecision(text: string | undefined, open: OpenIssue[]): Decision {
  const json = text?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("Triage returned no JSON");
  const d = Decision.parse(JSON.parse(json));
  if (d.action === "merge" && !open.some((i) => i.number === d.issueNumber)) {
    return { ...d, action: "create", issueNumber: undefined };
  }
  return d;
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
