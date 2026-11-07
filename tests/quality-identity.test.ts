import { describe, expect, it } from "vitest";
import {
  branchHasIssueToken,
  canonicalPrTitle,
  identityLines,
  issueHtmlUrl,
  qualityIdentity,
  suggestedFixBranch,
} from "@/lib/quality-identity";

describe("quality identity", () => {
  it("uses the issue number once it exists and keeps the case id secondary", () => {
    expect(qualityIdentity({ issue: 90, caseId: "kb-0123456789abcdef" })).toEqual({
      canonical: "issue",
      issue: 90,
      issueToken: "issue-90",
      issueUrl: null,
      caseId: "kb-0123456789abcdef",
    });
    expect(issueHtmlUrl(90, "MarcusGCY/KoffeeBean")).toBe("https://github.com/MarcusGCY/KoffeeBean/issues/90");
    expect(identityLines({
      issue: 90,
      caseId: "kb-0123456789abcdef",
      url: "https://github.com/MarcusGCY/KoffeeBean/issues/90",
    })).toEqual([
      "Issue #90",
      "https://github.com/MarcusGCY/KoffeeBean/issues/90",
      "Case kb-0123456789abcdef",
    ]);
  });

  it("does not invent an issue number before one exists", () => {
    const identity = qualityIdentity({ caseId: "kb-0123456789abcdef" });
    expect(identity).toEqual({
      canonical: "provisional",
      issue: null,
      issueToken: null,
      issueUrl: null,
      caseId: "kb-0123456789abcdef",
    });
    const lines = identityLines({ caseId: "kb-0123456789abcdef" });
    expect(lines).toEqual(["Case kb-0123456789abcdef", "No GitHub issue number yet."]);
    expect(lines.join("\n")).not.toContain("issue-");
    expect(lines.join("\n")).not.toContain("Issue #");
  });

  it("builds one PR title and matches only the exact issue token", () => {
    expect(canonicalPrTitle(90, "House Espresso image not loading")).toBe(
      "Issue #90: House Espresso image not loading",
    );
    expect(canonicalPrTitle(90, "Issue #90: House Espresso image not loading")).toBe(
      "Issue #90: House Espresso image not loading",
    );
    expect(canonicalPrTitle(90, "issue #90: House Espresso image not loading")).toBe(
      "Issue #90: House Espresso image not loading",
    );
    expect(branchHasIssueToken("cursor/issue-90-house-espresso", 90)).toBe(true);
    expect(branchHasIssueToken("cursor/issue-9-house", 90)).toBe(false);
    expect(branchHasIssueToken("cursor/issue-900-house", 90)).toBe(false);
    expect(branchHasIssueToken("cursor/fix-house-espresso-image-6573", 90)).toBe(false);
    expect(suggestedFixBranch(90, "house-espresso")).toBe("cursor/issue-90-house-espresso");
  });
});
