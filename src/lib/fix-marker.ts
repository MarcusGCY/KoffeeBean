/** Cloud-agent metadata key storing the GitHub issue number. */
export const BEANBOX_ISSUE_METADATA = "beanboxIssue";

export const FIX_RUN_MARKER = "beanbox-cursor-run";
export const FIX_RESULT_MARKER = "beanbox-fix-result";

export type FixRunRef = { agentId: string; runId: string; startedAt: number };

export function fixRunComment(ref: FixRunRef): string {
  return [
    `<!-- ${FIX_RUN_MARKER} ${JSON.stringify(ref)} -->`,
    "Cursor cloud agent is working on this fix.",
    `Agent \`${ref.agentId}\`, run \`${ref.runId}\`.`,
  ].join("\n");
}

export function fixResultComment(summary: string): string {
  return `${summary}\n\n<!-- ${FIX_RESULT_MARKER} -->`;
}

export function parseFixRun(body: string): FixRunRef | undefined {
  const match = body.match(/<!--\s*beanbox-cursor-run\s+(\{[\s\S]*?\})\s*-->/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { agentId?: unknown; runId?: unknown; startedAt?: unknown };
    if (typeof parsed.agentId !== "string" || typeof parsed.runId !== "string") return undefined;
    if (!parsed.agentId || !parsed.runId) return undefined;
    const startedAt = typeof parsed.startedAt === "number" && parsed.startedAt > 0
      ? parsed.startedAt
      : Date.now();
    return { agentId: parsed.agentId, runId: parsed.runId, startedAt };
  } catch {
    return undefined;
  }
}

export function hasFixResult(body: string): boolean {
  return body.includes(`<!-- ${FIX_RESULT_MARKER} -->`);
}
