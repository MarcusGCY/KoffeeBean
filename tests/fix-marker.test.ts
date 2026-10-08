import { describe, expect, it } from "vitest";
import { fixResultComment, fixRunComment, hasFixResult, parseFixRun } from "@/lib/fix-marker";

describe("fix run marker", () => {
  it("round-trips the agent and run ids stored on the issue", () => {
    const body = fixRunComment({ agentId: "bc-1", runId: "run-2", startedAt: 100 });
    expect(parseFixRun(body)).toEqual({ agentId: "bc-1", runId: "run-2", startedAt: 100 });
    expect(hasFixResult(body)).toBe(false);
    expect(hasFixResult(fixResultComment("Cursor opened a fix: https://github.com/acme/beanbox/pull/1"))).toBe(true);
    expect(parseFixRun("no marker")).toBeUndefined();
  });
});