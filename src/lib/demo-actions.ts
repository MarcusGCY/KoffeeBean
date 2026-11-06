import { MainMovedError, githubStatus, publicGitHubError, type CommitMeta, type DemoRepo, type MainCommit } from "./demo-repo";
import {
  DEMO_BUG_COMMIT,
  DEMO_BUG_PATHS,
  DEMO_SETUP_COMMIT,
  commitIsLive,
  mainIsDeploying,
  pullNumberFromSubject,
  pullNumbersFromText,
  resetCommitMessage,
  resetIssueComment,
  revertCommitMessage,
  revertedIssueComment,
  revertsByPull,
  statusLabel,
  type FixStatus,
} from "./demo-status";
import { planFileChanges, transformFile, type FileSnapshot, type PlannedFile, type TransformResult } from "./text-patch";

const ATTEMPTS = 3;
const REPRO_PREFIX = "tests/repro/";

/**
 * Planted bug text and the fixed text that replaced it on main.
 * When current main is the fixed file, reset writes the planted file in full
 * instead of replaying the original line patch.
 */
const PLANTED_SWAPS: Record<string, { buggy: string; fixed: string }[]> = {
  "src/lib/cart.ts": [
    { buggy: 'productId.replace("tote", "canvas-tote")', fixed: "productId" },
  ],
  "src/lib/images.ts": [{ buggy: "imges/beans", fixed: "images/beans" }],
  "src/data/products.json": [{ buggy: '"price": 25000', fixed: '"price": 2500' }],
};

/** Fixed form of a planted file. Equal to `planted` when this path has no known swap. */
function fixedForm(path: string, planted: string): string {
  return (PLANTED_SWAPS[path] ?? []).reduce(
    (text, swap) => text.split(swap.buggy).join(swap.fixed),
    planted,
  );
}

/**
 * Write the planted file when main is that file or its known fixed form.
 * Otherwise keep the contextual patch. A real mismatch still fails.
 */
export function restorePlantedFile(file: FileSnapshot): TransformResult {
  const { path, before, after, current } = file;
  if (after != null && current === after) return { ok: true, text: current, changed: false };
  if (after != null && current != null) {
    const fixed = fixedForm(path, after);
    if (fixed !== after && current === fixed) return { ok: true, text: after, changed: true };
  }
  return transformFile(before, after, current, "forward");
}

function planPlantedRestore(files: FileSnapshot[]): ReturnType<typeof planFileChanges> {
  const planned: PlannedFile[] = [];
  for (const file of files) {
    const result = restorePlantedFile(file);
    if (!result.ok) return { ok: false, path: file.path, reason: result.reason };
    if (result.changed) planned.push({ path: file.path, text: result.text });
  }
  return { ok: true, files: planned, changed: planned.length > 0 };
}

/**
 * Repro tests added after the setup commit are deleted.
 * A file that exists in that commit is restored to it.
 * A 404 means the file is already gone.
 */
export async function reproFilesToReset(repo: DemoRepo, head: string): Promise<PlannedFile[]> {
  const [setupPaths, headPaths] = await Promise.all([
    repo.pathsUnder(DEMO_SETUP_COMMIT, REPRO_PREFIX),
    repo.pathsUnder(head, REPRO_PREFIX),
  ]);
  const setup = new Set(setupPaths);
  const onHead = new Set(headPaths);
  const planned: PlannedFile[] = [];
  for (const path of headPaths) {
    if (setup.has(path)) continue;
    const live = await readOrGone(repo, path, head);
    if (live === null) continue;
    planned.push({ path, text: null });
  }
  for (const path of setupPaths) {
    const original = await readOrGone(repo, path, DEMO_SETUP_COMMIT);
    if (original === null) {
      if (!onHead.has(path)) continue;
      const live = await readOrGone(repo, path, head);
      if (live === null) continue;
      planned.push({ path, text: null });
      continue;
    }
    const live = onHead.has(path) ? await readOrGone(repo, path, head) : null;
    if (live === original) continue;
    planned.push({ path, text: original });
  }
  return planned;
}

async function readOrGone(repo: DemoRepo, path: string, ref: string): Promise<string | null> {
  try {
    return await repo.fileAt(path, ref);
  } catch (error) {
    if (githubStatus(error) === 404) return null;
    throw error;
  }
}

export type DemoFixRow = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueState: "open" | "closed";
  prNumber: number;
  prUrl: string;
  mergeSha?: string;
  revertSha?: string;
  status: FixStatus;
  deploying: boolean;
  statusLabel: string;
  canRevert: boolean;
};

export type DemoOverview = {
  rows: DemoFixRow[];
  mainSha: string;
  deployedSha?: string;
  deployingMain: boolean;
  repoUrl: string;
};

export type DemoActionResult = {
  flash: "reverted" | "already" | "reset" | "reset-already" | "conflict" | "error";
  detail: string;
};

export async function listDemoFixes(repo: DemoRepo): Promise<DemoOverview> {
  const [issues, commits] = await Promise.all([repo.feedbackIssues(), repo.mainCommits()]);
  const mainSha = commits[0]?.sha ?? (await repo.headSha());
  const deployedSha = repo.deployedSha();
  const revertShas = revertsByPull(commits);
  const mergeByPr = new Map<number, MainCommit>();
  for (const commit of commits) {
    const pr = pullNumberFromSubject(commit.message);
    if (pr && !mergeByPr.has(pr)) mergeByPr.set(pr, commit);
  }

  const withComments = await Promise.all(
    issues.map(async (issue) => ({
      issue,
      prs: pullNumbersFromText(
        [issue.body, ...(await repo.commentBodies(issue.number))].join("\n"),
        repo.repoFullName(),
      ),
    })),
  );

  const rows: DemoFixRow[] = [];
  for (const { issue, prs } of withComments) {
    for (const prNumber of prs) {
      const merge = mergeByPr.get(prNumber);
      let mergeSha = merge?.sha;
      if (!mergeSha) {
        const pull = await repo.pull(prNumber);
        if (pull?.merged && pull.mergeSha && (await repo.onMain(pull.mergeSha))) {
          mergeSha = pull.mergeSha;
        }
      }
      const revertSha = revertShas.get(prNumber);
      const reverted = Boolean(mergeSha && revertSha && isNewer(commits, revertSha, mergeSha));
      const status: FixStatus = !mergeSha ? "unmerged" : reverted ? "reverted" : "merged";
      const liveTarget = status === "reverted" ? revertSha : mergeSha;
      const deploying = Boolean(liveTarget && !commitIsLive(commits, deployedSha, liveTarget));
      rows.push({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        issueState: issue.state,
        prNumber,
        prUrl: `${repo.repoUrl()}/pull/${prNumber}`,
        mergeSha,
        revertSha: reverted ? revertSha : undefined,
        status,
        deploying,
        statusLabel: statusLabel(status, deploying),
        canRevert: status === "merged",
      });
    }
  }

  return {
    rows,
    mainSha,
    deployedSha,
    deployingMain: mainIsDeploying(mainSha, deployedSha),
    repoUrl: repo.repoUrl(),
  };
}

export async function revertMergedFix(
  repo: DemoRepo,
  pr: number,
  requestedIssue?: number,
): Promise<DemoActionResult> {
  const commits = await repo.mainCommits();
  const located = await locateMerge(repo, commits, pr);
  if (!located) {
    return {
      flash: "error",
      detail: `Pull request ${pr} is not a squash merge on main, so it was not reverted.`,
    };
  }

  let meta: CommitMeta;
  try {
    meta = await repo.commitMeta(located.sha);
  } catch (error) {
    return { flash: "error", detail: publicGitHubError(error) };
  }
  if (meta.parents.length !== 1) {
    return {
      flash: "error",
      detail: `Commit ${located.sha.slice(0, 7)} has ${meta.parents.length} parents. Only a squash merge can be reverted this way. Nothing was committed.`,
    };
  }
  if (meta.files.length === 0) {
    return {
      flash: "error",
      detail: "GitHub did not list the files in that commit. Nothing was committed.",
    };
  }
  const blocked = unsupportedFile(meta);
  if (blocked) {
    return {
      flash: "conflict",
      detail: `Can't revert pull request ${pr} cleanly. ${blocked} Nothing was committed.`,
    };
  }

  const parent = meta.parents[0];
  const issue = await linkedIssue(repo, pr, requestedIssue);
  const title = issue ? await titleOf(repo, issue) : undefined;
  let sha = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const head = await repo.headSha();
    let snapshots: FileSnapshot[];
    try {
      snapshots = await snapshotsFor(repo, meta, parent, located.sha, head);
    } catch (error) {
      return { flash: "error", detail: publicGitHubError(error) };
    }
    const plan = planFileChanges(snapshots, "reverse");
    if (!plan.ok) {
      return {
        flash: "conflict",
        detail: `Can't revert pull request ${pr} cleanly. ${plan.path}: ${plan.reason} Nothing was committed.`,
      };
    }
    if (!plan.changed) {
      const warning = await closeRevertedIssue(
        repo,
        issue,
        [
          `The merged fix (pull request ${pr}) is already undone on main, so no new commit was created.`,
          "",
          "This issue stays closed and is labeled `demo-reverted`, so the next shopper report opens a fresh issue instead of merging into this one.",
        ].join("\n"),
      );
      const detail = `Pull request ${pr} is already reverted on main. Nothing was committed.`;
      return { flash: "already", detail: warning ? `${detail} ${warning}` : detail };
    }
    try {
      sha = await repo.commitOnMain(
        head,
        revertCommitMessage({ issue, pr, mergeSha: located.sha, title }),
        plan.files,
      );
      break;
    } catch (error) {
      if (error instanceof MainMovedError && attempt < ATTEMPTS - 1) continue;
      if (error instanceof MainMovedError) {
        return { flash: "error", detail: "main moved while committing. Nothing was committed. Try again." };
      }
      return { flash: "error", detail: publicGitHubError(error) };
    }
  }
  if (!sha) {
    return { flash: "error", detail: "main moved while committing. Nothing was committed. Try again." };
  }
  const warning = await closeRevertedIssue(repo, issue, revertedIssueComment({
    pr,
    sha,
    repoUrl: repo.repoUrl(),
  }));
  const detail = `Committed ${sha.slice(0, 7)} to main. Vercel will redeploy with the bug restored.`;
  return { flash: "reverted", detail: warning ? `${detail} ${warning}` : detail };
}

export async function resetDemoBugs(repo: DemoRepo): Promise<DemoActionResult> {
  let source: CommitMeta;
  try {
    source = await repo.commitMeta(DEMO_BUG_COMMIT);
  } catch (error) {
    return { flash: "error", detail: publicGitHubError(error) };
  }
  if (source.parents.length !== 1) {
    return {
      flash: "error",
      detail: "The demo bug commit is not a single-parent commit. Nothing was committed.",
    };
  }
  for (const path of DEMO_BUG_PATHS) {
    if (!source.files.some((file) => file.path === path)) {
      return {
        flash: "error",
        detail: `Demo bug commit ${DEMO_BUG_COMMIT.slice(0, 7)} does not change ${path}. Nothing was committed.`,
      };
    }
  }
  const blocked = unsupportedFile({
    ...source,
    files: source.files.filter((file) => (DEMO_BUG_PATHS as readonly string[]).includes(file.path)),
  });
  if (blocked) return { flash: "conflict", detail: `${blocked} Nothing was committed.` };

  try {
    await repo.deleteTriageBranches();
  } catch (error) {
    const status = githubStatus(error);
    if (status !== 404 && status !== 422) return { flash: "error", detail: publicGitHubError(error) };
  }

  const parent = source.parents[0];
  let sha = "";
  let undone: number[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const head = await repo.headSha();
    let snapshots: FileSnapshot[];
    try {
      snapshots = await Promise.all(
        DEMO_BUG_PATHS.map(async (path) => ({
          path,
          before: await repo.fileAt(path, parent),
          after: await repo.fileAt(path, DEMO_BUG_COMMIT),
          current: await repo.fileAt(path, head),
        })),
      );
    } catch (error) {
      return { flash: "error", detail: publicGitHubError(error) };
    }
    const plan = planPlantedRestore(snapshots);
    if (!plan.ok) {
      return {
        flash: "conflict",
        detail: `Can't restore the demo bugs cleanly. ${plan.path}: ${plan.reason} Nothing was committed.`,
      };
    }
    let reproFiles: PlannedFile[];
    try {
      reproFiles = await reproFilesToReset(repo, head);
    } catch (error) {
      return { flash: "error", detail: publicGitHubError(error) };
    }
    const files = [...plan.files, ...reproFiles];
    if (files.length === 0) {
      const undone = await pullsFullyUndone(repo, head, []);
      const warnings = await closeUndoneIssues(repo, undone, head, true);
      const detail = "The three demo bugs are already in the code on main. Nothing was committed.";
      return { flash: "reset-already", detail: warnings.length ? `${detail} ${warnings.join(" ")}` : detail };
    }
    try {
      undone = await pullsFullyUndone(repo, head, files);
      sha = await repo.commitOnMain(head, resetCommitMessage(DEMO_BUG_COMMIT, undone), files);
      break;
    } catch (error) {
      if (error instanceof MainMovedError && attempt < ATTEMPTS - 1) continue;
      if (error instanceof MainMovedError) {
        return { flash: "error", detail: "main moved while committing. Nothing was committed. Try again." };
      }
      return { flash: "error", detail: publicGitHubError(error) };
    }
  }
  if (!sha) {
    return { flash: "error", detail: "main moved while committing. Nothing was committed. Try again." };
  }

  const warnings = await closeUndoneIssues(repo, undone, sha);
  const detail = `Committed ${sha.slice(0, 7)} to main. Vercel will redeploy with the demo bugs restored.`;
  return { flash: "reset", detail: warnings.length ? `${detail} ${warnings.join(" ")}` : detail };
}

async function locateMerge(
  repo: DemoRepo,
  commits: MainCommit[],
  pr: number,
): Promise<{ sha: string } | undefined> {
  const fromSubject = commits.find((commit) => pullNumberFromSubject(commit.message) === pr);
  if (fromSubject) return { sha: fromSubject.sha };
  const pull = await repo.pull(pr);
  if (!pull?.merged || !pull.mergeSha) return undefined;
  if (!(await repo.onMain(pull.mergeSha))) return undefined;
  return { sha: pull.mergeSha };
}

async function snapshotsFor(
  repo: DemoRepo,
  meta: CommitMeta,
  parent: string,
  commitSha: string,
  head: string,
): Promise<FileSnapshot[]> {
  return Promise.all(
    meta.files.map(async (file) => ({
      path: file.path,
      before: await repo.fileAt(file.path, parent),
      after: await repo.fileAt(file.path, commitSha),
      current: await repo.fileAt(file.path, head),
    })),
  );
}

function unsupportedFile(meta: CommitMeta): string | undefined {
  const renamed = meta.files.find((file) => file.status === "renamed" || file.status === "copied");
  if (renamed) return `${renamed.path} was renamed, which this revert does not apply.`;
  return undefined;
}

async function linkedIssue(repo: DemoRepo, pr: number, requested?: number): Promise<number | undefined> {
  if (requested && (await issueReferencesPull(repo, requested, pr))) return requested;
  const issues = await repo.feedbackIssues();
  for (const issue of issues) {
    if (await issueReferencesPull(repo, issue.number, pr)) return issue.number;
  }
  return undefined;
}

async function issueReferencesPull(repo: DemoRepo, issue: number, pr: number): Promise<boolean> {
  const issues = await repo.feedbackIssues();
  const found = issues.find((item) => item.number === issue);
  if (!found) return false;
  const comments = await repo.commentBodies(issue);
  const text = [found.body, ...comments].join("\n");
  return pullNumbersFromText(text, repo.repoFullName()).includes(pr);
}

async function titleOf(repo: DemoRepo, issue: number): Promise<string | undefined> {
  const issues = await repo.feedbackIssues();
  return issues.find((item) => item.number === issue)?.title;
}

async function closeRevertedIssue(repo: DemoRepo, issue: number | undefined, body: string): Promise<string | undefined> {
  if (!issue) return "The code was updated, but no linked feedback issue was found to close.";
  try {
    await repo.markIssueReverted(issue, body);
    return undefined;
  } catch (error) {
    return `The code was updated, but issue #${issue} could not be closed: ${publicGitHubError(error)}`;
  }
}

async function closeUndoneIssues(
  repo: DemoRepo,
  undone: number[],
  sha: string,
  already = false,
): Promise<string[]> {
  if (undone.length === 0) return [];
  const overview = await listDemoFixes(repo).catch(() => undefined);
  const warnings: string[] = [];
  for (const pr of undone) {
    const issue = overview?.rows.find((row) => row.prNumber === pr)?.issueNumber;
    const body = already
      ? [
          "The planted demo bugs are already back on main, which undoes the fix for this issue. No new commit was created.",
          "",
          "This issue stays closed and is labeled `demo-reverted`, so the next shopper report opens a fresh issue instead of merging into this one.",
        ].join("\n")
      : resetIssueComment({ sha, repoUrl: repo.repoUrl() });
    const warning = await closeRevertedIssue(repo, issue, body);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

/**
 * Merged fixes whose reverse patch is already a no-op once `replacements`
 * are applied on top of `head`. Those pulls are recorded on the reset commit.
 */
async function pullsFullyUndone(repo: DemoRepo, head: string, replacements: PlannedFile[]): Promise<number[]> {
  const overview = await listDemoFixes(repo);
  const replacement = new Map(replacements.map((file) => [file.path, file.text]));
  const undone: number[] = [];
  for (const row of overview.rows) {
    if (row.status !== "merged" || !row.mergeSha) continue;
    const meta = await repo.commitMeta(row.mergeSha);
    if (meta.parents.length !== 1) continue;
    if (unsupportedFile(meta)) continue;
    const parent = meta.parents[0];
    const snapshots: FileSnapshot[] = [];
    let failed = false;
    for (const file of meta.files) {
      try {
        const current = replacement.has(file.path)
          ? replacement.get(file.path)!
          : await repo.fileAt(file.path, head);
        snapshots.push({
          path: file.path,
          before: await repo.fileAt(file.path, parent),
          after: await repo.fileAt(file.path, row.mergeSha),
          current,
        });
      } catch {
        failed = true;
        break;
      }
    }
    if (failed || snapshots.length === 0) continue;
    const plan = planFileChanges(snapshots, "reverse");
    if (plan.ok && !plan.changed) undone.push(row.prNumber);
  }
  return undone;
}

function isNewer(commitsNewestFirst: { sha: string }[], candidate: string, older: string): boolean {
  const candidateIdx = commitsNewestFirst.findIndex((commit) => commit.sha === candidate);
  const olderIdx = commitsNewestFirst.findIndex((commit) => commit.sha === older);
  if (candidateIdx === -1 || olderIdx === -1) return candidateIdx !== -1;
  return candidateIdx < olderIdx;
}
