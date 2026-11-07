import { describe, expect, it } from "vitest";
import {
  branchHasIssueToken,
  branchNonconformance,
  canonicalPrTitle,
  caseTokenInArtifact,
  identityLines,
  identityMismatchDetail,
  issueHtmlUrl,
  qualityIdentity,
  reproIdentityMismatch,
  suggestedFixBranch,
} from "@/lib/quality-identity";
import { isExactTriageBranch } from "@/lib/reproduce";

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
    expect(branchNonconformance("cursor/fix-house-espresso-image-6573", 90)).toContain("Nonconformance");
    expect(branchNonconformance("cursor/issue-90-house-espresso", 90)).toBeUndefined();
  });

  it("requires the same case token in a new repro path and triage branch, and still accepts a legacy name", () => {
    const caseId = "kb-0123456789abcdef";
    const path = `tests/repro/${caseId}-house-espresso.test.ts`;
    const branch = `beanbox-triage/${caseId}-house-espresso-bc-84c2c`;
    expect(caseTokenInArtifact(path, caseId)).toBe(true);
    expect(caseTokenInArtifact(branch, caseId)).toBe(true);
    expect(reproIdentityMismatch(caseId, path, branch)).toBeUndefined();
    expect(isExactTriageBranch(branch, path)).toBe(true);
    expect(caseTokenInArtifact(`tests/repro/${caseId}f-house.test.ts`, caseId)).toBe(false);
    expect(caseTokenInArtifact(`tests/repro/x${caseId}-house.test.ts`, caseId)).toBe(false);
    expect(reproIdentityMismatch(caseId, "tests/repro/house-espresso.test.ts", "beanbox-triage/house-espresso-bc-84c2c")).toMatchObject({
      expected: caseId,
    });
    expect(identityMismatchDetail({
      expected: caseId,
      testPath: "tests/repro/house-espresso.test.ts",
      branch: "beanbox-triage/house-espresso-bc-84c2c",
    })).toContain("Identity mismatch");
    expect(isExactTriageBranch(
      "beanbox-triage/house-espresso-image-bc-84c2c",
      "tests/repro/house-espresso-image.test.ts",
    )).toBe(true);
    expect(reproIdentityMismatch(undefined, "tests/repro/house-espresso-image.test.ts", "beanbox-triage/house-espresso-image-bc-84c2c")).toBeUndefined();
  });
});
