import { describe, expect, it } from "vitest";
import { issueNumbersFromText } from "@/lib/issue-refs";

describe("issueNumbersFromText", () => {
  it("reads GitHub closing keywords and ignores a bare hash", () => {
    const text = "Fixes #12\nThis also closes #4 and resolves: #12. See #9.";
    expect(issueNumbersFromText(text)).toEqual([12, 4]);
  });
});
