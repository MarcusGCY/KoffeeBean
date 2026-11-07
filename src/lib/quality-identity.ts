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

/** `Issue #90: House Espresso image not loading`. An existing prefix is not doubled. */
export function canonicalPrTitle(issue: number, title: string): string {
  const heading = issueHeading(issue);
  if (!heading) return title.trim();
  const stripped = title.replace(new RegExp(`^\\s*issue\\s*#\\s*${issue}\\s*:\\s*`, "i"), "").trim();
  return stripped ? `${heading}: ${stripped}` : heading;
}

export function branchHasIssueToken(branch: string | null | undefined, issue: number): boolean {
  const token = issueToken(issue);
  if (!token || !branch) return false;
  return new RegExp(`(?:^|[^0-9])${token}(?:[^0-9]|$)`).test(branch.toLowerCase());
}

export function suggestedFixBranch(issue: number, slug: string): string | undefined {
  const token = issueToken(issue);
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!token || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean)) return undefined;
  return `cursor/${token}-${clean}`;
}
