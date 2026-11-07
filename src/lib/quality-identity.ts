const CASE_ID = /^kb-[0-9a-f]{16}$/;

/** Machine token used in branch names after a GitHub issue exists. `issue-90`, not `issue-9` inside `issue-90`. */
export function issueToken(issue: number | null | undefined): string | undefined {
  if (!Number.isInteger(issue) || !issue || issue <= 0) return undefined;
  return `issue-${issue}`;
}

/** Human prefix. Example: `Issue #90`. */
export function issueHeading(issue: number | null | undefined): string | undefined {
  if (!issueToken(issue)) return undefined;
  return `Issue #${issue}`;
}

export function issueHtmlUrl(issue: number | null | undefined, repo = process.env.GITHUB_REPO): string | undefined {
  if (!issueToken(issue)) return undefined;
  const configured = repo?.trim();
  if (!configured) return undefined;
  const [owner, name, extra] = configured.split("/");
  if (!owner || !name || extra !== undefined) return undefined;
  return `https://github.com/${owner}/${name}/issues/${issue}`;
}

export function provisionalCaseId(caseId: string | null | undefined): string | undefined {
  if (!caseId || !CASE_ID.test(caseId)) return undefined;
  return caseId;
}

export type QualityIdentity = {
  canonical: "issue" | "provisional";
  issue: number | null;
  issueToken: string | null;
  issueUrl: string | null;
  caseId: string | null;
};

/** Issue number is canonical once it exists. The case id is only the pre-issue correlation, then a secondary reference. */
export function qualityIdentity(input: {
  issue?: number | null;
  caseId?: string | null;
  url?: string | null;
}): QualityIdentity {
  const caseId = provisionalCaseId(input.caseId);
  const issue = issueToken(input.issue) ? input.issue! : null;
  if (issue) {
    return {
      canonical: "issue",
      issue,
      issueToken: issueToken(issue) ?? null,
      issueUrl: input.url ?? issueHtmlUrl(issue) ?? null,
      caseId: caseId ?? null,
    };
  }
  return {
    canonical: "provisional",
    issue: null,
    issueToken: null,
    issueUrl: null,
    caseId: caseId ?? null,
  };
}

export function identityLines(input: {
  issue?: number | null;
  caseId?: string | null;
  url?: string | null;
}): string[] {
  const identity = qualityIdentity(input);
  if (identity.canonical === "issue" && identity.issue) {
    const lines = [issueHeading(identity.issue)!];
    if (identity.issueUrl) lines.push(identity.issueUrl);
    if (identity.caseId) lines.push(`Case ${identity.caseId}`);
    return lines;
  }
  if (identity.caseId) return [`Case ${identity.caseId}`, "No GitHub issue number yet."];
  return [];
}

/**
 * `Issue #90: House Espresso image not loading`.
 * Empty and heading-only titles stay `Issue #90`. Applying this twice does not produce `Issue #90: Issue #90`.
 * `Issue #900` is a different number and is not stripped.
 */
export function canonicalPrTitle(issue: number, title: string): string {
  const heading = issueHeading(issue);
  if (!heading) return title.trim();
  let rest = title.trim();
  const lead = new RegExp(`^issue\\s*#\\s*${issue}(?!\\d)\\s*:?\\s*`, "i");
  while (lead.test(rest)) rest = rest.replace(lead, "").trim();
  if (rest.toLowerCase() === heading.toLowerCase()) rest = "";
  return rest ? `${heading}: ${rest}` : heading;
}

/** True when `token` is a whole alphanumeric token, not a prefix, suffix, or infix of a longer token. */
export function hasWholeToken(value: string | null | undefined, token: string | null | undefined): boolean {
  if (!token || !value) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(value);
}

/** True when `caseId` appears as a whole token, not as a prefix of a longer token. */
export function caseTokenInArtifact(value: string | null | undefined, caseId: string | null | undefined): boolean {
  return hasWholeToken(value, provisionalCaseId(caseId));
}

/**
 * Append identity lines that are not already present. Existing text is kept.
 * A second call with the same lines returns the same string.
 * GitHub has no compare-and-swap for the body, so the caller should skip the
 * write when this returns the original body.
 */
export function appendIdentityLines(body: string, lines: string[]): string {
  const missing = lines.filter((line) => line && !identityLinePresent(body, line));
  if (missing.length === 0) return body;
  const base = body.replace(/\s*$/, "");
  const suffix = missing.join("\n");
  return base ? `${base}\n\n${suffix}\n` : `${suffix}\n`;
}

function identityLinePresent(body: string, line: string): boolean {
  const heading = line.match(/^Issue #(\d+)$/);
  if (heading) {
    return new RegExp(`(?:^|\\n)\\s*Issue #${heading[1]}(?!\\d)(?:\\s*:|\\s|$)`, "i").test(body);
  }
  if (body.split(/\r?\n/).some((item) => item.trim() === line)) return true;
  return hasWholeToken(body, line);
}

export type IdentityMismatch = {
  expected: string;
  testPath?: string;
  branch?: string;
};

/**
 * New triage runs must return a repro path and branch that both contain the case token.
 * A missing path is not a mismatch; that stays the existing no-test result.
 * Legacy artifacts are not checked here.
 */
export function reproIdentityMismatch(
  caseId: string | null | undefined,
  testPath: string | undefined,
  branch: string | undefined,
): IdentityMismatch | undefined {
  const id = provisionalCaseId(caseId);
  if (!id) return undefined;
  if (!testPath && !branch) return undefined;
  if (caseTokenInArtifact(testPath, id) && caseTokenInArtifact(branch, id)) return undefined;
  return { expected: id, testPath, branch };
}

export function identityMismatchDetail(mismatch: IdentityMismatch): string {
  return [
    `Identity mismatch. Expected case token ${mismatch.expected} in the repro file and triage branch.`,
    `Actual test: ${mismatch.testPath ?? "none"}.`,
    `Actual branch: ${mismatch.branch ?? "none"}.`,
    "No review is requested.",
  ].join(" ");
}

export function branchNonconformance(branch: string | null | undefined, issue: number): string | undefined {
  const token = issueToken(issue);
  if (!token || branchHasIssueToken(branch, issue)) return undefined;
  return `Nonconformance: branch ${branch ?? "unknown"} does not contain ${token}. The branch was not renamed.`;
}

export function branchHasIssueToken(branch: string | null | undefined, issue: number): boolean {
  return hasWholeToken(branch, issueToken(issue));
}

export function suggestedFixBranch(issue: number, slug: string): string | undefined {
  const token = issueToken(issue);
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!token || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean)) return undefined;
  return `cursor/${token}-${clean}`;
}
