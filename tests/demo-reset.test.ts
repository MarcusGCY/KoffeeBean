import type { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { GithubDemoRepo } from "@/lib/demo-repo";
import { DEMO_SETUP_COMMIT } from "@/lib/demo-status";

function githubError(status: number): Error {
  return Object.assign(new Error("GitHub"), { status });
}

describe("demo reset GitHub calls", () => {
  it("skips a 422 from POST /labels when the label already exists", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const createLabel = vi.fn(async () => {
      throw githubError(422);
    });
    const addLabels = vi.fn(async () => ({ data: [] }));
    const createComment = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => ({ data: {} }));
    const client = { issues: { createLabel, addLabels, createComment, update } } as unknown as Octokit;
    const repo = new GithubDemoRepo(client, "acme", "beanbox");
    await expect(repo.markIssueReverted(63, "Reset.")).resolves.toBeUndefined();
    expect(createLabel).toHaveBeenCalledOnce();
    expect(addLabels).toHaveBeenCalledOnce();
    expect(createComment).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 63, state: "closed" }));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("deletes only beanbox-triage refs and treats 404 and 422 as already gone", async () => {
    const deleteRef = vi.fn(async ({ ref }: { ref: string }) => {
      if (ref.endsWith("/gone")) throw Object.assign(new Error("missing"), { status: 404 });
      if (ref.endsWith("/stale")) throw Object.assign(new Error("unprocessable"), { response: { status: 422 } });
    });
    const listMatchingRefs = vi.fn(async () => ({
      data: [
        { ref: "refs/heads/beanbox-triage/house-espresso-image-bc-70874" },
        { ref: "refs/heads/beanbox-triage/gone" },
        { ref: "refs/heads/beanbox-triage/stale" },
        { ref: "refs/heads/main" },
        { ref: "refs/heads/cursor/triage-unique-branch" },
      ],
    }));
    const client = { git: { listMatchingRefs, deleteRef } } as unknown as Octokit;
    const repo = new GithubDemoRepo(client, "acme", "beanbox");
    await expect(repo.deleteTriageBranches()).resolves.toBeUndefined();
    expect(listMatchingRefs).toHaveBeenCalledWith(expect.objectContaining({ ref: "heads/beanbox-triage/" }));
    expect(deleteRef.mock.calls.map((call) => call[0].ref)).toEqual([
      "heads/beanbox-triage/house-espresso-image-bc-70874",
      "heads/beanbox-triage/gone",
      "heads/beanbox-triage/stale",
    ]);
  });

  it("treats a 404 from the contents API as a file that is already deleted", async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
    });
    const client = { repos: { getContent } } as unknown as Octokit;
    const repo = new GithubDemoRepo(client, "acme", "beanbox");
    await expect(repo.fileAt("tests/repro/house-espresso-image.test.ts", DEMO_SETUP_COMMIT)).resolves.toBeNull();
    expect(getContent).toHaveBeenCalledOnce();
  });
});
