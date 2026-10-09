/** Label applied when a feedback issue's fix is undone for another demo run. */
export const DEMO_REVERTED_LABEL = "demo-reverted";

/**
 * Squash merge that planted the three shopper-visible bugs
 * (bean image path, Canvas Tote cart, Roast Day T-Shirt price).
 */
export const DEMO_BUG_COMMIT = "5cb688963970c83b30bcef265506a58b12084250";

export const DEMO_BUG_PATHS = [
  "src/lib/images.ts",
  "src/lib/cart.ts",
  "src/data/products.json",
] as const;

const REVERT_MARKER_RE = /<!--\s*beanbox-revert\s+(\{.*\})\s*-->/;
const RESET_MARKER_RE = /<!--\s*beanbox-demo-reset\s+(\{.*\})\s*-->/;
const SUBJECT_PR_RE = /\(#(\d+)\)\s*$/;

export type RevertMarker = { issue?: number; pr: number; merge: string };
export type ResetMarker = { source: string; reverts: number[] };

export function pullNumberFromSubject(message: string): number | undefined {
  const subject = message.split("\n", 1)[0] ?? "";
  const match = subject.match(SUBJECT_PR_RE);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function pullNumbersFromText(text: string, repoFullName: string): number[] {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name) return [];
  const re = new RegExp(
    `https://github.com/${escapeRegExp(owner)}/${escapeRegExp(name)}/pull/(\\d+)\\b`,
    "gi",
  );
  const seen = new Set<number>();
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen];
}

export function revertCommitMessage(input: {
  issue?: number;
  pr: number;
  mergeSha: string;
  title?: string;
}): string {
  const marker = JSON.stringify({
    issue: input.issue ?? null,
    pr: input.pr,
    merge: input.mergeSha,
  });
  const subject = input.issue
    ? `Revert demo fix for issue #${input.issue} (pull request ${input.pr}).`
    : `Revert demo fix for pull request ${input.pr}.`;
  const what = input.title
    ? `Restores the shop bug from "${input.title}" so the BeanBox demo can run again.`
    : "Restores the shop bug so the BeanBox demo can run again.";
  return [
    subject,
    "",
    what,
    `Squash merge ${input.mergeSha}.`,
    "",
    `<!-- beanbox-revert ${marker} -->`,
  ].join("\n");
}

export function resetCommitMessage(source: string, reverts: number[]): string {
  const marker = JSON.stringify({ source, reverts });
  return [
    "Reset BeanBox demo bugs.",
    "",
    "Restores the planted catalog bugs from the demo setup commit:",
    "bean image path, Canvas Tote cart id, and Roast Day T-Shirt price.",
    `Source commit ${source}.`,
    "",
    `<!-- beanbox-demo-reset ${marker} -->`,
  ].join("\n");
}

export function revertedIssueComment(input: { pr: number; sha: string; repoUrl: string }): string {
  return [
    `Reverted the merged fix (pull request ${input.pr}) on main so this shop bug can be demoed again.`,
    `Commit: ${input.repoUrl}/commit/${input.sha}`,
    "",
    "This issue stays closed and is labeled `demo-reverted`, so the next shopper report opens a fresh issue instead of merging into this one.",
  ].join("\n");
}

export function resetIssueComment(input: { sha: string; repoUrl: string }): string {
  return [
    "Reset the planted BeanBox demo bugs on main, which undoes the fix for this issue.",
    `Commit: ${input.repoUrl}/commit/${input.sha}`,
    "",
    "This issue stays closed and is labeled `demo-reverted`, so the next shopper report opens a fresh issue instead of merging into this one.",
  ].join("\n");
}

export function parseRevertMarker(message: string): RevertMarker | undefined {
  const match = message.match(REVERT_MARKER_RE);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { issue?: unknown; pr?: unknown; merge?: unknown };
    if (typeof parsed.pr !== "number" || !Number.isInteger(parsed.pr) || parsed.pr <= 0) return undefined;
    if (typeof parsed.merge !== "string" || !parsed.merge) return undefined;
    const issue = typeof parsed.issue === "number" && Number.isInteger(parsed.issue) && parsed.issue > 0
      ? parsed.issue
      : undefined;
    return { issue, pr: parsed.pr, merge: parsed.merge };
  } catch {
    return undefined;
  }
}

export function parseResetMarker(message: string): ResetMarker | undefined {
  const match = message.match(RESET_MARKER_RE);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as { source?: unknown; reverts?: unknown };
    if (typeof parsed.source !== "string" || !parsed.source) return undefined;
    if (!Array.isArray(parsed.reverts)) return undefined;
    const reverts = parsed.reverts.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
    return { source: parsed.source, reverts };
  } catch {
    return undefined;
  }
}

/** Newest revert or demo-reset commit that names each pull request. */
export function revertsByPull(commitsNewestFirst: { sha: string; message: string }[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const commit of commitsNewestFirst) {
    const revert = parseRevertMarker(commit.message);
    if (revert && !map.has(revert.pr)) map.set(revert.pr, commit.sha);
    const reset = parseResetMarker(commit.message);
    if (!reset) continue;
    for (const pr of reset.reverts) {
      if (!map.has(pr)) map.set(pr, commit.sha);
    }
  }
  return map;
}

/**
 * True when `targetSha` is the deployed commit or an ancestor of it within
 * `commitsNewestFirst`. Missing `deployedSha` (local dev) is treated as live.
 * A target we cannot place relative to the deployment is not called live.
 */
export function commitIsLive(
  commitsNewestFirst: { sha: string }[],
  deployedSha: string | undefined,
  targetSha: string,
): boolean {
  if (!deployedSha) return true;
  if (deployedSha === targetSha) return true;
  const deployedIdx = commitsNewestFirst.findIndex((commit) => commit.sha === deployedSha);
  const targetIdx = commitsNewestFirst.findIndex((commit) => commit.sha === targetSha);
  if (targetIdx === -1) return deployedIdx !== -1;
  if (deployedIdx === -1) return false;
  return targetIdx >= deployedIdx;
}

export function mainIsDeploying(mainSha: string, deployedSha: string | undefined): boolean {
  return Boolean(deployedSha && deployedSha !== mainSha);
}

export type FixStatus = "merged" | "reverted" | "unmerged";

export function statusLabel(status: FixStatus, deploying: boolean): string {
  if (status === "unmerged") return "Not merged";
  if (status === "merged") return deploying ? "Merged · deploying" : "Merged";
  return deploying ? "Reverted · deploying" : "Reverted";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
