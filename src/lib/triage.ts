import { Agent, type RunResult } from "@cursor/sdk";
import { z } from "zod";
import { env, repo } from "./env";
import type { OpenIssue } from "./github";

const Decision = z.object({
  action: z.enum(["create", "merge"]),
  issueNumber: z.number().int().optional(),
  title: z.string(),
  body: z.string(),
});
export type Decision = z.infer<typeof Decision>;

const ATTEMPTS = 2;
const PREVIEW_MAX = 160;

/**
 * Ask a Cursor agent (read-only "plan" mode) to decide whether a feedback
 * report duplicates an open issue, and to draft the issue text if it doesn't.
 *
 * A plan run sometimes ends with status "error" and an empty message when
 * launched from Next.js after(). Retry once on a new agent before giving up.
 */
export async function triageFeedback(
  feedback: string,
  open: OpenIssue[],
): Promise<Decision> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const agent = await Agent.create({
      apiKey: env("CURSOR_API_KEY"),
      // Parallel reports must not share one cloud agent name.
      name: `beanbox-triage-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      mode: "plan",
      cloud: { repos: [{ url: repo().url }], autoCreatePR: false },
    });
    try {
      const run = await agent.send(prompt(feedback, open));
      const result = await run.wait();
      if (result.status !== "finished") {
        const err = triageRunError(result);
        if (result.status === "error" && attempt < ATTEMPTS) {
          lastError = err;
          continue;
        }
        throw err;
      }
      return parseDecision(result.result, open);
    } finally {
      agent.close();
    }
  }
  throw lastError ?? new Error("Triage run error");
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
  const parts = [
    `Triage run ${result.status}`,
    `durationMs=${duration}`,
    `requestId=${requestId}`,
  ];
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
