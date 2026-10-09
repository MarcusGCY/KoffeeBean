import { describe, expect, it } from "vitest";
import { listDemoFixes, resetDemoBugs, revertMergedFix } from "@/lib/demo-actions";
import { MainMovedError, type CommitMeta, type DemoRepo, type MainCommit } from "@/lib/demo-repo";
import { DEMO_BUG_COMMIT, parseResetMarker, parseRevertMarker } from "@/lib/demo-status";

const PARENT = "b".repeat(40);
const MERGE = "c".repeat(40);
const HEAD = "d".repeat(40);
const BUG_PARENT = "e".repeat(40);

const FIXED = "export function productImageUrl() {\n  return \"images/beans\";\n}\n";
const BUGGY = "export function productImageUrl() {\n  return \"imges/beans\";\n}\n";
const HEADER = "// later commit\n";
const GOOD_CART = "export function addItem(id) {\n  return id;\n}\n";
const BAD_CART = "export function addItem(id) {\n  return id.replace(\"tote\", \"canvas-tote\");\n}\n";
const CHEAP = "{ \"id\": \"tee\", \"price\": 2500 }\n";
const PRICEY = "{ \"id\": \"tee\", \"price\": 25000 }\n";

function repo(options?: { currentImages?: string; moveMain?: boolean; conflict?: boolean }): DemoRepo & {
  commits: MainCommit[];
  marked: number[];
  commitCount: number;
} {
  const files = new Map<string, Map<string, string | null>>();
  const put = (ref: string, path: string, text: string | null) => {
    const tree = files.get(ref) ?? new Map<string, string | null>();
    tree.set(path, text);
    files.set(ref, tree);
  };
  const copy = (from: string, to: string) => {
    files.set(to, new Map(files.get(from) ?? []));
  };

  put(PARENT, "src/lib/images.ts", BUGGY);
  put(MERGE, "src/lib/images.ts", FIXED);
  put(HEAD, "src/lib/images.ts", options?.conflict ? "something else\n" : (options?.currentImages ?? `${HEADER}${FIXED}`));
  put(HEAD, "src/lib/cart.ts", BAD_CART);
  put(HEAD, "src/data/products.json", PRICEY);
  put(BUG_PARENT, "src/lib/images.ts", FIXED);
  put(BUG_PARENT, "src/lib/cart.ts", GOOD_CART);
  put(BUG_PARENT, "src/data/products.json", CHEAP);
  put(DEMO_BUG_COMMIT, "src/lib/images.ts", BUGGY);
  put(DEMO_BUG_COMMIT, "src/lib/cart.ts", BAD_CART);
  put(DEMO_BUG_COMMIT, "src/data/products.json", PRICEY);

  const state = {
    head: HEAD,
    commits: [
      { sha: HEAD, message: "Note after the image fix.", date: "2026-10-08T15:00:00Z" },
      { sha: MERGE, message: "Fix coffee bean product image URLs. (#23)", date: "2026-10-08T14:10:38Z" },
    ] as MainCommit[],
    marked: [] as number[],
    commitCount: 0,
    moveMain: options?.moveMain ?? false,
  };

  const api: DemoRepo = {
    repoFullName: () => "acme/beanbox",
    repoUrl: () => "https://github.com/acme/beanbox",
    deployedSha: () => HEAD,
    async feedbackIssues() {
      return [{
        number: 22,
        title: "Coffee bean product images do not load",
        body: "Beans 404.",
        state: "closed",
        url: "https://github.com/acme/beanbox/issues/22",
      }];
    },
    async commentBodies() {
      return ["Cursor opened a fix: https://github.com/acme/beanbox/pull/23\n\n<!-- beanbox-fix-result -->"];
    },
    async mainCommits() {
      return state.commits;
    },
    async headSha() {
      return state.head;
    },
    async commitMeta(sha: string): Promise<CommitMeta> {
      if (sha === MERGE) {
        return {
          sha,
          message: "Fix coffee bean product image URLs. (#23)",
          parents: [PARENT],
          files: [{ path: "src/lib/images.ts", status: "modified" }],
        };
      }
      if (sha === DEMO_BUG_COMMIT) {
        return {
          sha,
          message: "Plant three separate shopper-visible catalog bugs. (#17)",
          parents: [BUG_PARENT],
          files: [
            { path: "src/lib/images.ts", status: "modified" },
            { path: "src/lib/cart.ts", status: "modified" },
            { path: "src/data/products.json", status: "modified" },
            { path: "README.md", status: "modified" },
          ],
        };
      }
      throw new Error(`unknown commit ${sha}`);
    },
    async fileAt(path: string, ref: string) {
      return files.get(ref)?.get(path) ?? null;
    },
    async onMain() {
      return true;
    },
    async pull() {
      return null;
    },
    async commitOnMain(parentSha, message, planned) {
      if (state.moveMain) {
        state.moveMain = false;
        const moved = "f".repeat(40);
        copy(state.head, moved);
        state.head = moved;
        state.commits = [{ sha: moved, message: "someone else", date: "" }, ...state.commits];
        throw new MainMovedError();
      }
      if (parentSha !== state.head) throw new MainMovedError();
      const sha = `1${state.commitCount}${"a".repeat(38)}`;
      copy(parentSha, sha);
      for (const file of planned) {
        const tree = files.get(sha) ?? new Map();
        tree.set(file.path, file.text);
        files.set(sha, tree);
      }
      state.commitCount += 1;
      state.head = sha;
      state.commits = [{ sha, message, date: "2026-10-08T16:00:00Z" }, ...state.commits];
      return sha;
    },
    async markIssueReverted(issue) {
      state.marked.push(issue);
    },
  };

  return {
    ...api,
    get commits() {
      return state.commits;
    },
    get marked() {
      return state.marked;
    },
    get commitCount() {
      return state.commitCount;
    },
  };
}

describe("revertMergedFix", () => {
  it("lists the merged image fix as revertable", async () => {
    const overview = await listDemoFixes(repo());
    expect(overview.rows).toHaveLength(1);
    expect(overview.rows[0]).toMatchObject({
      issueNumber: 22,
      prNumber: 23,
      mergeSha: MERGE,
      status: "merged",
      statusLabel: "Merged",
      canRevert: true,
      deploying: false,
    });
  });

  it("commits the inverse onto later unrelated lines and closes the feedback issue", async () => {
    const source = repo();
    const result = await revertMergedFix(source, 23, 22);
    expect(result.flash).toBe("reverted");
    expect(source.commitCount).toBe(1);
    expect(source.marked).toEqual([22]);
    const committed = source.commits[0];
    expect(parseRevertMarker(committed.message)).toMatchObject({ issue: 22, pr: 23, merge: MERGE });
    expect(committed.message).not.toMatch(/\(#23\)/);
    const images = await source.fileAt("src/lib/images.ts", committed.sha);
    expect(images).toBe(`${HEADER}${BUGGY}`);
  });

  it("does not commit when the same lines no longer match", async () => {
    const source = repo({ conflict: true });
    const result = await revertMergedFix(source, 23, 22);
    expect(result.flash).toBe("conflict");
    expect(result.detail).toContain("src/lib/images.ts");
    expect(result.detail).toContain("Nothing was committed");
    expect(source.commitCount).toBe(0);
    expect(source.marked).toEqual([]);
  });

  it("retries once when main moves", async () => {
    const source = repo({ moveMain: true });
    const result = await revertMergedFix(source, 23, 22);
    expect(result.flash).toBe("reverted");
    expect(source.commitCount).toBe(1);
    expect(source.marked).toEqual([22]);
  });

  it("does not commit when the bug is already back", async () => {
    const source = repo({ currentImages: BUGGY });
    const result = await revertMergedFix(source, 23, 22);
    expect(result.flash).toBe("already");
    expect(source.commitCount).toBe(0);
    expect(source.marked).toEqual([22]);
  });
});

describe("resetDemoBugs", () => {
  it("restores only the fixed bug lines and records the undone pull request", async () => {
    const source = repo();
    const result = await resetDemoBugs(source);
    expect(result.flash).toBe("reset");
    expect(source.commitCount).toBe(1);
    expect(source.marked).toEqual([22]);
    const committed = source.commits[0];
    expect(parseResetMarker(committed.message)?.reverts).toEqual([23]);
    expect(await source.fileAt("src/lib/images.ts", committed.sha)).toBe(`${HEADER}${BUGGY}`);
    expect(await source.fileAt("src/lib/cart.ts", committed.sha)).toBe(BAD_CART);
    expect(await source.fileAt("src/data/products.json", committed.sha)).toBe(PRICEY);
    expect(await source.fileAt("README.md", committed.sha)).toBeNull();
  });

  it("does not commit when the three bugs are already planted", async () => {
    const source = repo({ currentImages: BUGGY });
    const result = await resetDemoBugs(source);
    expect(result.flash).toBe("reset-already");
    expect(source.commitCount).toBe(0);
    expect(source.marked).toEqual([22]);
  });
});
