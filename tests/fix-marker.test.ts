import { describe, expect, it } from "vitest";
import {
  fixMergedComment,
  fixResultComment,
  fixRunComment,
  hasFixMerged,
  hasFixResult,
  parseFixResult,
  parseFixRun,
  recordedFixPull,
} from "@/lib/fix-marker";

const PR = "https://github.com/acme/beanbox/pull/15";

describe("fix run marker", () => {
  it("round-trips the agent and run ids stored on the issue", () => {
    const body = fixRunComment({ agentId: "bc-1", runId: "run-2", startedAt: 100 });
    expect(parseFixRun(body)).toEqual({ agentId: "bc-1", runId: "run-2", startedAt: 100 });
    expect(hasFixResult(body)).toBe(false);
    expect(hasFixResult(fixResultComment("Cursor opened a fix: https://github.com/acme/beanbox/pull/1"))).toBe(true);
    expect(parseFixRun("no marker")).toBeUndefined();
  });

  it("keeps the old fix-result marker and reads a pull URL from the prose", () => {
    const body = fixResultComment(`Cursor opened a fix: ${PR}`);
    expect(hasFixResult(body)).toBe(true);
    expect(parseFixResult(body)).toEqual({});
    expect(recordedFixPull([body], "acme/beanbox")).toEqual({ prNumber: 15 });
  });

  it("round-trips the pull request and head branch on the fix-result comment", () => {
    const body = fixResultComment(`Cursor opened a fix: ${PR}`, {
      prUrl: PR,
      prNumber: 15,
      head: "cursor/beanbox-fix-14",
    });
    expect(parseFixResult(body)).toEqual({ prUrl: PR, prNumber: 15, head: "cursor/beanbox-fix-14" });
    expect(recordedFixPull([body], "acme/beanbox")).toEqual({
      prNumber: 15,
      prUrl: PR,
      head: "cursor/beanbox-fix-14",
    });
    expect(hasFixMerged(body)).toBe(false);
    expect(hasFixMerged(fixMergedComment(PR, "abc"))).toBe(true);
  });
});