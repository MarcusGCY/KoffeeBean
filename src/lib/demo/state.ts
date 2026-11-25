import { randomUUID } from "node:crypto";
import { redisPipeline, redisTransaction } from "../upstash";

/** Every Redis key the Pelita demo track touches lives under this prefix. */
export const KEY_PREFIX = "kb:demo:pelita:";

/**
 * The complete, fixed set of state keys. The `claim:` keys and `opening` are write guards
 * (SET NX), `elapsed` is the presenter's choice of elapsed-time source, and `epoch` is the
 * reset fence. Reset deletes every key here except `epoch`, which it replaces with a new token.
 */
export const STATE_KEY_NAMES = [
  "stage",
  "approvals",
  "audit",
  "listed",
  "claim:sourcing",
  "claim:launch",
  "opening",
  "elapsed",
  "epoch",
] as const;
export type StateKeyName = (typeof STATE_KEY_NAMES)[number];

/**
 * What Reset deletes. The epoch is not on this list on purpose: deleting it would put it back
 * to "missing", the value every request that started before the very first reset also saw, so
 * a stale write could pass the fence. Reset replaces it with a fresh token instead.
 */
export const RESET_KEY_NAMES: readonly StateKeyName[] = STATE_KEY_NAMES.filter((name) => name !== "epoch");

/** The only place a demo key is built. */
export function key(name: StateKeyName): string {
  if (!(STATE_KEY_NAMES as readonly string[]).includes(name)) {
    throw new Error("Unknown demo state key");
  }
  return `${KEY_PREFIX}${name}`;
}

export const STATE_KEYS: readonly string[] = STATE_KEY_NAMES.map(key);

/** Screens 00-07 of the mockups. */
export const MIN_STAGE = 0;
export const MAX_STAGE = 7;

/** `stage` while the agent is on screen 03: after approval 1, before the listing draft. */
export const STOCK_CHECK_STAGE = 3;
/** `stage` once the presenter has moved past screen 03 on to the listing draft (screen 04). */
export const PAST_STOCK_CHECK_STAGE = 4;
/** `stage` once the drafted listing has been sent for approval (screen 05). */
export const LAUNCH_APPROVAL_STAGE = 5;
/** `stage` once approval 2 has published the listing (screen 06). */
export const PUBLISHED_STAGE = 6;

export type ApprovalSlot = "sourcing" | "launch";

export type DemoApproval = {
  approvalId: string;
  approverId: string;
  at: string;
};

export type DemoAuditRow = {
  at: string;
  actorKind: "agent" | "human" | "system";
  actor: string;
  action: string;
  source: string;
  ref: string | null;
};

export type DemoState = {
  stage: number;
  approvals: Partial<Record<ApprovalSlot, DemoApproval>>;
  audit: DemoAuditRow[];
  listed: boolean;
};

type Command = (string | number)[];

const COMMANDS = new Set(["GET", "SET", "DEL", "RPUSH", "LRANGE"]);

/** How long a claim guard outlives its request, so a request that died mid-write cannot block the slot for good. */
const CLAIM_TTL_SEC = 60;

/** What a request that started before any reset sees for the epoch. */
const NO_EPOCH = "0";

/** Raised when a reset happened after a request began, so its write was dropped. */
export class StaleEpochError extends Error {
  constructor() {
    super("reset_during_request");
  }
}

function check(commands: Command[]): void {
  for (const command of commands) {
    const [name, target] = command;
    if (typeof name !== "string" || !COMMANDS.has(name)) throw new Error("Demo store command not allowed");
    if (typeof target !== "string" || !target.startsWith(KEY_PREFIX) || !STATE_KEYS.includes(target)) {
      throw new Error("Demo store key outside the demo prefix");
    }
  }
}

/**
 * Every demo write and read goes through here. Each command names exactly one
 * key, and it must be inside the demo prefix and on the fixed list. With
 * `atomic` the commands run as one MULTI/EXEC.
 */
async function run(commands: Command[], atomic = false): Promise<unknown[]> {
  check(commands);
  return atomic ? redisTransaction(commands) : redisPipeline(commands);
}

/**
 * Runs `commands` as one atomic script that first compares the epoch key with the epoch the
 * request read when it began, and does nothing if Reset has changed it since. Returns the result
 * of the last command. REST cannot WATCH across requests, so the check lives inside the script.
 * The commands are validated here exactly as `run` validates them; the script only replays them.
 */
const FENCE_SCRIPT = `local cur = redis.call('GET', KEYS[1])
if (cur or '${NO_EPOCH}') ~= ARGV[1] then return 'STALE' end
local last = nil
local i = 2
while i <= #ARGV do
  local n = tonumber(ARGV[i])
  local cmd = {}
  for j = 1, n do cmd[j] = ARGV[i + j] end
  last = redis.call(unpack(cmd))
  i = i + n + 1
end
return last`;

async function fenced(epoch: string, commands: Command[]): Promise<unknown> {
  check(commands);
  const epochKey = key("epoch");
  const keys = [epochKey, ...STATE_KEYS.filter((k) => k !== epochKey)];
  const args = commands.flatMap((command) => [command.length, ...command]);
  const [result] = await redisPipeline([["EVAL", FENCE_SCRIPT, keys.length, ...keys, epoch, ...args]]);
  if (result === "STALE") throw new StaleEpochError();
  return result;
}

/** Fenced when the caller holds an epoch, a plain request otherwise (the low-level helpers used by tests). */
async function write(commands: Command[], epoch: string | undefined, atomic = false): Promise<unknown> {
  if (epoch !== undefined) return fenced(epoch, commands);
  const results = await run(commands, atomic);
  return results[results.length - 1];
}

function parseStage(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= MIN_STAGE && n <= MAX_STAGE ? n : MIN_STAGE;
}

function parseApprovals(value: unknown): DemoState["approvals"] {
  if (typeof value !== "string") return {};
  try {
    const data = JSON.parse(value) as Record<string, unknown>;
    const out: DemoState["approvals"] = {};
    for (const slot of ["sourcing", "launch"] as const) {
      const row = data[slot] as Record<string, unknown> | undefined;
      if (row && typeof row.approvalId === "string" && typeof row.approverId === "string" && typeof row.at === "string") {
        out[slot] = { approvalId: row.approvalId, approverId: row.approverId, at: row.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseAudit(value: unknown): DemoAuditRow[] {
  if (!Array.isArray(value)) return [];
  const rows: DemoAuditRow[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    try {
      const row = JSON.parse(item) as DemoAuditRow;
      if (row && typeof row.at === "string" && typeof row.action === "string") rows.push(row);
    } catch {
      continue;
    }
  }
  return rows;
}

export async function getDemoState(): Promise<DemoState> {
  const [stage, approvals, audit, listed] = await run([
    ["GET", key("stage")],
    ["GET", key("approvals")],
    ["LRANGE", key("audit"), 0, -1],
    ["GET", key("listed")],
  ]);
  return {
    stage: parseStage(stage),
    approvals: parseApprovals(approvals),
    audit: parseAudit(audit),
    listed: listed === "1",
  };
}

/** Where the screen 06 and 07 elapsed time comes from. The fixture figure is the default. */
export type ElapsedMode = "fixture" | "real";
export const DEFAULT_ELAPSED_MODE: ElapsedMode = "fixture";

function parseElapsedMode(value: unknown): ElapsedMode {
  return value === "real" ? "real" : DEFAULT_ELAPSED_MODE;
}

/** The state plus what a write path needs from the moment it begins: the reset epoch and the presenter's elapsed-time choice. */
export type DemoSnapshot = { state: DemoState; epoch: string; elapsedMode: ElapsedMode };

export async function getDemoSnapshot(): Promise<DemoSnapshot> {
  const [stage, approvals, audit, listed, epoch, elapsed] = await run([
    ["GET", key("stage")],
    ["GET", key("approvals")],
    ["LRANGE", key("audit"), 0, -1],
    ["GET", key("listed")],
    ["GET", key("epoch")],
    ["GET", key("elapsed")],
  ]);
  return {
    state: { stage: parseStage(stage), approvals: parseApprovals(approvals), audit: parseAudit(audit), listed: listed === "1" },
    epoch: typeof epoch === "string" && epoch !== "" ? epoch : NO_EPOCH,
    elapsedMode: parseElapsedMode(elapsed),
  };
}

export async function getElapsedMode(): Promise<ElapsedMode> {
  const [value] = await run([["GET", key("elapsed")]]);
  return parseElapsedMode(value);
}

/** The presenter's choice of elapsed-time source. Reset puts it back to the fixture default. */
export async function setElapsedMode(mode: ElapsedMode, epoch?: string): Promise<void> {
  if (mode !== "fixture" && mode !== "real") throw new Error("Unknown elapsed mode");
  await write([["SET", key("elapsed"), mode]], epoch);
}

export async function setStage(stage: number, epoch?: string): Promise<void> {
  if (!Number.isInteger(stage) || stage < MIN_STAGE || stage > MAX_STAGE) {
    throw new Error("Demo stage out of range");
  }
  await write([["SET", key("stage"), String(stage)]], epoch);
}

export async function setListed(listed: boolean): Promise<void> {
  await run([["SET", key("listed"), listed ? "1" : "0"]]);
}

export async function recordApproval(slot: ApprovalSlot, approval: DemoApproval): Promise<void> {
  const [current] = await run([["GET", key("approvals")]]);
  const next = { ...parseApprovals(current), [slot]: approval };
  await run([["SET", key("approvals"), JSON.stringify(next)]]);
}

/** What approval 2 changes besides the approval itself: the publish audit rows, the listed flag and the stage. */
export type CommitExtras = { rows?: DemoAuditRow[]; listed?: boolean; stage?: number };

/** The guard keys: one per approval slot, plus the once-per-reset opening rows. */
export type GuardName = "claim:sourcing" | "claim:launch" | "opening";
export const SLOT_GUARDS: Record<ApprovalSlot, GuardName> = { sourcing: "claim:sourcing", launch: "claim:launch" };

/** Who holds a guard. A request that loses a guard reads this to say why. */
export type GuardHolder = "approve" | "send_back" | "reject" | "opening";

export type GuardResult = { won: true } | { won: false; heldBy: string | null };

/**
 * `SET guard holder NX EX`, inside the epoch fence: for exactly one caller until the key expires
 * or Reset deletes it. A request from before a reset throws StaleEpochError instead of taking a
 * guard in the new epoch.
 */
export async function takeGuard(name: GuardName, holder: GuardHolder, epoch: string): Promise<GuardResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if ((await fenced(epoch, [["SET", key(name), holder, "NX", "EX", CLAIM_TTL_SEC]])) === "OK") return { won: true };
    const [heldBy] = await run([["GET", key(name)]]);
    if (typeof heldBy === "string") return { won: false, heldBy };
  }
  return { won: false, heldBy: null };
}

/** Gives a guard back after a failed write. A reset in between has already cleared it, so a stale release does nothing. */
export async function releaseGuard(name: GuardName, epoch: string): Promise<void> {
  await fenced(epoch, [["DEL", key(name)]]).catch(() => undefined);
}

export type CommitResult = { ok: true } | { ok: false; heldBy: string | null };

/**
 * Records one approval and its audit row, together with any `extras` (approval 2 publishes in
 * the same script, so a reader never sees an approval without its listing). Writes nothing and
 * returns `ok: false` when the slot already holds an approval or another request holds its guard.
 *
 * The slot is claimed first with SET NX on its own key, so two simultaneous requests for the same
 * slot cannot both get past it, and a send back or rejection that took the same guard cannot race
 * an approval. Claim and write both run inside the epoch fence: a reset since `epoch` was read
 * drops the write. A claim whose write failed is released so the approver can try again.
 */
export async function commitApproval(
  slot: ApprovalSlot,
  approval: DemoApproval,
  row: DemoAuditRow,
  epoch: string,
  extras: CommitExtras = {},
): Promise<CommitResult> {
  if (extras.stage !== undefined && (!Number.isInteger(extras.stage) || extras.stage < MIN_STAGE || extras.stage > MAX_STAGE)) {
    throw new Error("Demo stage out of range");
  }
  const guard = SLOT_GUARDS[slot];
  const claimed = await takeGuard(guard, "approve", epoch);
  if (!claimed.won) return { ok: false, heldBy: claimed.heldBy };
  try {
    const [current] = await run([["GET", key("approvals")]]);
    const approvals = parseApprovals(current);
    if (approvals[slot]) return { ok: false, heldBy: "approve" };
    const commands: Command[] = [
      ["SET", key("approvals"), JSON.stringify({ ...approvals, [slot]: approval })],
      ["RPUSH", key("audit"), JSON.stringify(row)],
      ...(extras.rows ?? []).map((extra): Command => ["RPUSH", key("audit"), JSON.stringify(extra)]),
    ];
    if (extras.listed !== undefined) commands.push(["SET", key("listed"), extras.listed ? "1" : "0"]);
    if (extras.stage !== undefined) commands.push(["SET", key("stage"), String(extras.stage)]);
    await fenced(epoch, commands);
    return { ok: true };
  } catch (error) {
    await releaseGuard(guard, epoch);
    throw error;
  }
}

/**
 * Writes the two opening agent rows once per reset. Returns false and writes nothing when
 * the audit list is not empty or another request holds the guard. Both rows go in one script.
 */
export async function commitOpeningRows(rows: DemoAuditRow[], epoch: string): Promise<boolean> {
  if (rows.length === 0) return false;
  if (!(await takeGuard("opening", "opening", epoch)).won) return false;
  try {
    const [existing] = await run([["LRANGE", key("audit"), 0, 0]]);
    if (Array.isArray(existing) && existing.length > 0) return false;
    await fenced(
      epoch,
      rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]),
    );
    return true;
  } catch (error) {
    await releaseGuard("opening", epoch);
    throw error;
  }
}

export async function appendAudit(row: DemoAuditRow, epoch?: string): Promise<void> {
  await write([["RPUSH", key("audit"), JSON.stringify(row)]], epoch);
}

/** Appends several audit rows in one request, so readers never see only some of them. */
export async function appendAuditRows(rows: DemoAuditRow[], epoch?: string): Promise<void> {
  if (rows.length === 0) return;
  await write(rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]), epoch);
}

/** Appends audit rows and moves the stage in one request, so a reader never sees the rows without the stage. */
export async function appendAuditRowsAndSetStage(rows: DemoAuditRow[], stage: number, epoch?: string): Promise<void> {
  if (!Number.isInteger(stage) || stage < MIN_STAGE || stage > MAX_STAGE) throw new Error("Demo stage out of range");
  await write([...rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]), ["SET", key("stage"), String(stage)]], epoch);
}

/**
 * Deletes the fixed key list (no SCAN, no wildcards), reseeds stage 0 with nothing approved and
 * nothing listed, and replaces the epoch with a fresh token, all in one MULTI/EXEC. Every request
 * that began before this holds the old epoch, so its write is dropped.
 */
export async function resetDemo(token: string = randomUUID()): Promise<DemoState> {
  await run(
    [
      ...RESET_KEY_NAMES.map((name): Command => ["DEL", key(name)]),
      ["SET", key("stage"), "0"],
      ["SET", key("listed"), "0"],
      ["SET", key("epoch"), token],
    ],
    true,
  );
  return { stage: MIN_STAGE, approvals: {}, audit: [], listed: false };
}
