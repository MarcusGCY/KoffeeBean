/**
 * Line-level inverse/forward patch used to revert a squash merge onto
 * current main, or to re-apply the planted demo bugs.
 *
 * A later commit may shift or edit other lines. Application searches for the
 * changed lines plus surrounding context, then drops context a line at a time
 * when a neighbor was edited. It refuses when the changed lines themselves
 * do not match, or when more than one place matches, so a file is never
 * half-updated from a guess.
 */

const CONTEXT = 3;
const MAX_LINES = 4000;

export type FileSnapshot = {
  path: string;
  /** File text at the parent of the source commit. Null when the commit added it. */
  before: string | null;
  /** File text at the source commit. Null when the commit deleted it. */
  after: string | null;
  /** File text on the branch the result will be committed to. */
  current: string | null;
};

export type PlannedFile = { path: string; text: string | null };

export type PlanResult =
  | { ok: true; files: PlannedFile[]; changed: boolean }
  | { ok: false; path: string; reason: string };

export type TransformResult =
  | { ok: true; text: string | null; changed: boolean }
  | { ok: false; reason: string };

type Hunk = {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

type Op = {
  kind: "eq" | "del" | "ins";
  line: string;
  oldIndex?: number;
  newIndex?: number;
};

/** Keep a trailing newline as an empty final entry so joins round-trip. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Apply `before -> after` onto `current` (`forward`), or undo it (`reverse`).
 * `current` equal to the side we are leaving is a direct replace. `current`
 * equal to the side we want is a no-op. Anything else is a contextual patch.
 */
export function transformFile(
  before: string | null,
  after: string | null,
  current: string | null,
  direction: "forward" | "reverse",
): TransformResult {
  const source = direction === "forward" ? before : after;
  const target = direction === "forward" ? after : before;

  if (source === target || current === target) {
    return { ok: true, text: current, changed: false };
  }
  if (current === source) {
    return { ok: true, text: target, changed: true };
  }
  if (source === null || target === null || current === null || before === null || after === null) {
    return {
      ok: false,
      reason: "the file was added or removed, and the current file does not match either side of that change",
    };
  }
  if (splitLines(before).length > MAX_LINES || splitLines(after).length > MAX_LINES || splitLines(current).length > MAX_LINES) {
    return { ok: false, reason: "the file is too large to revert safely" };
  }

  const hunks = diffHunks(splitLines(before), splitLines(after));
  if (hunks.length === 0) {
    return { ok: false, reason: "could not isolate the changed lines" };
  }
  const applied = applyHunks(splitLines(current), hunks, direction);
  if (!applied.ok) return applied;
  const text = joinLines(applied.lines);
  return { ok: true, text, changed: text !== current };
}

/** Plan every file. One conflict aborts the whole plan; nothing is partial. */
export function planFileChanges(files: FileSnapshot[], direction: "forward" | "reverse"): PlanResult {
  const planned: PlannedFile[] = [];
  for (const file of files) {
    const result = transformFile(file.before, file.after, file.current, direction);
    if (!result.ok) return { ok: false, path: file.path, reason: result.reason };
    if (result.changed) planned.push({ path: file.path, text: result.text });
  }
  return { ok: true, files: planned, changed: planned.length > 0 };
}

function diffHunks(before: string[], after: string[]): Hunk[] {
  const ops = diffOps(before, after);
  const hunks: Hunk[] = [];
  let index = 0;
  while (index < ops.length) {
    if (ops[index].kind === "eq") {
      index += 1;
      continue;
    }
    let changeEnd = index;
    while (changeEnd < ops.length && ops[changeEnd].kind !== "eq") changeEnd += 1;
    while (true) {
      let cursor = changeEnd;
      let equals = 0;
      while (cursor < ops.length && ops[cursor].kind === "eq" && equals < CONTEXT * 2) {
        equals += 1;
        cursor += 1;
      }
      if (cursor < ops.length && ops[cursor].kind !== "eq") {
        changeEnd = cursor;
        while (changeEnd < ops.length && ops[changeEnd].kind !== "eq") changeEnd += 1;
        continue;
      }
      break;
    }
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(ops.length, changeEnd + CONTEXT);
    const slice = ops.slice(from, to);
    const oldLines = slice.filter((op) => op.kind !== "ins").map((op) => op.line);
    const newLines = slice.filter((op) => op.kind !== "del").map((op) => op.line);
    const oldStart = slice.find((op) => op.oldIndex !== undefined)?.oldIndex ?? 0;
    const newStart = slice.find((op) => op.newIndex !== undefined)?.newIndex ?? 0;
    hunks.push({ oldStart, newStart, oldLines, newLines });
    index = changeEnd;
  }
  return hunks;
}

function diffOps(before: string[], after: string[]): Op[] {
  const matches = lcsIndices(before, after);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [bi, aj] of matches) {
    while (i < bi) ops.push({ kind: "del", line: before[i], oldIndex: i++ });
    while (j < aj) ops.push({ kind: "ins", line: after[j], newIndex: j++ });
    ops.push({ kind: "eq", line: before[i], oldIndex: i++, newIndex: j++ });
  }
  while (i < before.length) ops.push({ kind: "del", line: before[i], oldIndex: i++ });
  while (j < after.length) ops.push({ kind: "ins", line: after[j], newIndex: j++ });
  return ops;
}

function lcsIndices(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

type ApplyOk = { ok: true; lines: string[] };
type ApplyFail = { ok: false; reason: string };

function applyHunks(current: string[], hunks: Hunk[], direction: "forward" | "reverse"): ApplyOk | ApplyFail {
  const edits: Array<{ start: number; remove: number; insert: string[] }> = [];
  for (const hunk of hunks) {
    const found = matchHunk(current, hunk, direction);
    if (found.kind === "skip") continue;
    if (found.kind !== "apply") return { ok: false, reason: found.reason };
    edits.push({ start: found.start, remove: found.remove, insert: found.insert });
  }
  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].start + edits[i - 1].remove) {
      return { ok: false, reason: "the changed regions overlap, so the file was left untouched" };
    }
  }
  const lines = current.slice();
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    lines.splice(edit.start, edit.remove, ...edit.insert);
  }
  return { ok: true, lines };
}

function matchHunk(
  lines: string[],
  hunk: Hunk,
  direction: "forward" | "reverse",
): { kind: "apply"; start: number; remove: number; insert: string[] } | { kind: "skip" } | { kind: "conflict" | "ambiguous"; reason: string } {
  const expectedFull = direction === "reverse" ? hunk.newLines : hunk.oldLines;
  const replacementFull = direction === "reverse" ? hunk.oldLines : hunk.newLines;
  const hint = direction === "reverse" ? hunk.newStart : hunk.oldStart;

  for (let fuzz = 0; fuzz <= CONTEXT; fuzz++) {
    const { expected, replacement } = shrink(expectedFull, replacementFull, fuzz);
    if (expected.length === 0) {
      if (replacement.length === 0) return { kind: "skip" };
      continue;
    }
    const at = locate(lines, expected, hint);
      if (at === "ambiguous") {
        if (fuzz === 0) {
          return { kind: "ambiguous", reason: "those lines match more than one place in the file" };
        }
        continue;
      }
    if (at === "missing") continue;
    if (sameLines(expected, replacement)) return { kind: "skip" };
    return { kind: "apply", start: at, remove: expected.length, insert: replacement };
  }

  for (let fuzz = 0; fuzz <= CONTEXT; fuzz++) {
    const { replacement } = shrink(expectedFull, replacementFull, fuzz);
    if (replacement.length === 0) continue;
    const at = locate(lines, replacement, hint);
    if (at === "ambiguous") {
      return { kind: "ambiguous", reason: "the reverted lines match more than one place in the file" };
    }
    if (typeof at === "number") return { kind: "skip" };
  }

  return {
    kind: "conflict",
    reason: "later edits touched the same lines, so the change does not match the current file",
  };
}

function shrink(expected: string[], replacement: string[], fuzz: number): { expected: string[]; replacement: string[] } {
  let prefix = 0;
  const shared = Math.min(expected.length, replacement.length);
  while (prefix < shared && expected[prefix] === replacement[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < expected.length - prefix &&
    suffix < replacement.length - prefix &&
    expected[expected.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const dropPrefix = Math.min(fuzz, prefix);
  const dropSuffix = Math.min(fuzz, suffix);
  return {
    expected: expected.slice(dropPrefix, expected.length - dropSuffix),
    replacement: replacement.slice(dropPrefix, replacement.length - dropSuffix),
  };
}

function locate(lines: string[], needle: string[], hint: number): number | "missing" | "ambiguous" {
  if (needle.length === 0 || needle.length > lines.length) return "missing";
  const hits: number[] = [];
  const last = lines.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let matches = true;
    for (let k = 0; k < needle.length; k++) {
      if (lines[i + k] !== needle[k]) {
        matches = false;
        break;
      }
    }
    if (matches) hits.push(i);
  }
  if (hits.length === 0) return "missing";
  if (hits.length === 1) return hits[0];
  hits.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint) || a - b);
  if (Math.abs(hits[0] - hint) < Math.abs(hits[1] - hint)) return hits[0];
  return "ambiguous";
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}
