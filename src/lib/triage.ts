import { Agent } from "@cursor/sdk";
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

/**
 * Ask a Cursor agent (read-only "plan" mode) to decide whether a feedback
 * report duplicates an open issue, and to draft the issue text if it doesn't.
 */
export async function triageFeedback(
  feedback: string,
  open: OpenIssue[],
): Promise<Decision> {
  const agent = await Agent.create({
    apiKey: env("CURSOR_API_KEY"),
    name: "beanbox-triage",
    mode: "plan",
    cloud: { repos: [{ url: repo().url }], autoCreatePR: false },
  });
  try {
    const run = await agent.send(
      [
        "You triage user feedback for the BeanBox online store (Next.js, code in src/lib and src/components).",
        "Decide if the feedback describes the SAME underlying bug as one of the open issues below.",
        "Look at the code if needed to find the real root cause; different wording can be one bug.",
        "",
        `## New feedback\n${feedback}`,
        "",
        `## Open issues\n${open.length ? open.map((i) => `#${i.number} ${i.title}\n${i.body.slice(0, 400)}`).join("\n\n") : "(none)"}`,
        "",
        'Reply with ONLY a JSON object: {"action":"merge"|"create","issueNumber":<n, merge only>,"title":"<short bug title>","body":"<markdown: summary, steps to reproduce, suspected file/root cause>"}',
      ].join("\n"),
    );
    const result = await run.wait();
    if (result.status !== "finished") throw new Error(`Triage run ${result.status}`);
    const json = result.result?.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("Triage returned no JSON");
    const d = Decision.parse(JSON.parse(json));
    if (d.action === "merge" && !open.some((i) => i.number === d.issueNumber)) {
      return { ...d, action: "create", issueNumber: undefined };
    }
    return d;
  } finally {
    agent.close();
  }
}
