import { pullNumbersFromText } from "./demo-status";

/** Cloud-agent metadata key storing the GitHub issue number. */
export const BEANBOX_ISSUE_METADATA = "beanboxIssue";

export const FIX_RUN_MARKER = "beanbox-cursor-run";
export const FIX_RESULT_MARKER = "beanbox-fix-result";
export const FIX_MERGED_MARKER = "beanbox-fix-merged";

export type FixRunRef = { agentId: string; runId: string; startedAt: number };

export function fixRunComment(ref: FixRunRef): string {
  return [
    `<!-- ${FIX_RUN_MARKER} ${JSON.stringify(ref)} -->`,
    "Cursor cloud agent is working on this fix.",
    `Agent \`${ref.agentId}\`, run \`${ref.runId}\`.`,
  ].join("\n");
}

export type FixResultMeta = { prNumber?: number; prUrl?: string; head?: string };

export function fixResultComment(summary: string, meta?: FixResultMeta): string {
  const payload: FixResultMeta = {};
  if (meta?.prNumber) payload.prNumber = meta.prNumber;
  if (meta?.prUrl) payload.prUrl = meta.prUrl;
  if (meta?.head) payload.head = meta.head;
  if (!payload.prNumber && !payload.prUrl && !payload.head) {
    return `${summary}\n\n<!-- ${FIX_RESULT_MARKER} -->`;
  }
  return `${summary}\n\n<!-- ${FIX_RESULT_MARKER} ${JSON.stringify(payload)} -->`;
}

export function fixMergedComment(prUrl: string, sha: string): string {
  return [
    `Squash-merged the fix: ${prUrl}`,
    `Merge commit \`${sha}\`.`,
    "Vercel will redeploy main shortly.",
    "",
    `<!-- ${FIX_MERGED_MARKER} -->`,
  ].join("\n");
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

export function parseFixResult(body: string): FixResultMeta | undefined {
  const match = body.match(/<!--\s*beanbox-fix-result(?:\s+(\{[\s\S]*?\}))?\s*-->/);
  if (!match) return undefined;
  if (!match[1]) return {};
  try {
    const parsed = JSON.parse(match[1]) as { prNumber?: unknown; prUrl?: unknown; head?: unknown };
    const meta: FixResultMeta = {};
    if (typeof parsed.prNumber === "number" && Number.isInteger(parsed.prNumber) && parsed.prNumber > 0) {
      meta.prNumber = parsed.prNumber;
    }
    if (typeof parsed.prUrl === "string" && parsed.prUrl) meta.prUrl = parsed.prUrl;
    if (typeof parsed.head === "string" && parsed.head.trim()) meta.head = parsed.head.trim();
    return meta;
  } catch {
    return {};
  }
}

/**
 * Pull request the fix-result comment recorded for this issue.
 * Structured metadata wins. Older comments that only contain the PR URL still match.
 */
export function recordedFixPull(
  bodies: string[],
  repoFullName: string,
): { prNumber: number; head?: string; prUrl?: string } | undefined {
  for (const body of bodies) {
    if (!hasFixResult(body)) continue;
    const meta = parseFixResult(body) ?? {};
    const prNumber = meta.prNumber ?? pullNumbersFromText(body, repoFullName)[0];
    if (!prNumber) continue;
    return { prNumber, head: meta.head, prUrl: meta.prUrl };
  }
  return undefined;
}

export function hasFixResult(body: string): boolean {
  return /<!--\s*beanbox-fix-result\b/.test(body);
}

export function hasFixMerged(body: string): boolean {
  return body.includes(`<!-- ${FIX_MERGED_MARKER} -->`);
}
