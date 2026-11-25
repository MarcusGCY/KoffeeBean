import { redisPipeline, redisTransaction } from "../upstash";

/** Every Redis key the Pelita demo track touches lives under this prefix. */
export const KEY_PREFIX = "kb:demo:pelita:";

/**
 * The complete, fixed set of state keys. Reset deletes exactly these. The `claim:` keys
 * and `opening` are write guards (SET NX), not state a screen reads.
 */
export const STATE_KEY_NAMES = ["stage", "approvals", "audit", "listed", "claim:sourcing", "claim:launch", "opening"] as const;
export type StateKeyName = (typeof STATE_KEY_NAMES)[number];

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

/**
 * Every demo write and read goes through here. Each command names exactly one
 * key, and it must be inside the demo prefix and on the fixed list. With
 * `atomic` the commands run as one MULTI/EXEC.
 */
async function run(commands: Command[], atomic = false): Promise<unknown[]> {
  for (const command of commands) {
    const [name, target] = command;
    if (typeof name !== "string" || !COMMANDS.has(name)) throw new Error("Demo store command not allowed");
    if (typeof target !== "string" || !target.startsWith(KEY_PREFIX) || !STATE_KEYS.includes(target)) {
      throw new Error("Demo store key outside the demo prefix");
    }
  }
  return atomic ? redisTransaction(commands) : redisPipeline(commands);
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

export async function setStage(stage: number): Promise<void> {
  if (!Number.isInteger(stage) || stage < MIN_STAGE || stage > MAX_STAGE) {
    throw new Error("Demo stage out of range");
  }
  await run([["SET", key("stage"), String(stage)]]);
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

const CLAIM_NAMES: Record<ApprovalSlot, StateKeyName> = { sourcing: "claim:sourcing", launch: "claim:launch" };

/** `SET key 1 NX EX`: true for exactly one caller until the key expires or is deleted. */
async function claim(name: StateKeyName): Promise<boolean> {
  const [result] = await run([["SET", key(name), "1", "NX", "EX", CLAIM_TTL_SEC]]);
  return result === "OK";
}

async function release(name: StateKeyName): Promise<void> {
  await run([["DEL", key(name)]]).catch(() => undefined);
}

/**
 * Records one approval and its audit row in a single MULTI/EXEC, together with any
 * `extras` (approval 2 publishes in the same transaction, so a reader never sees an
 * approval without its listing). Returns false and writes nothing when the slot
 * already holds an approval.
 *
 * The slot is claimed first with SET NX on its own key, so two simultaneous requests
 * for the same slot cannot both get past it: the second is refused. The approvals check
 * after the claim covers a claim that has expired since. A claim whose write failed is
 * released so the approver can try again.
 */
export async function commitApproval(
  slot: ApprovalSlot,
  approval: DemoApproval,
  row: DemoAuditRow,
  extras: CommitExtras = {},
): Promise<boolean> {
  if (extras.stage !== undefined && (!Number.isInteger(extras.stage) || extras.stage < MIN_STAGE || extras.stage > MAX_STAGE)) {
    throw new Error("Demo stage out of range");
  }
  const claimName = CLAIM_NAMES[slot];
  if (!(await claim(claimName))) return false;
  try {
    const [current] = await run([["GET", key("approvals")]]);
    const approvals = parseApprovals(current);
    if (approvals[slot]) return false;
    const commands: Command[] = [
      ["SET", key("approvals"), JSON.stringify({ ...approvals, [slot]: approval })],
      ["RPUSH", key("audit"), JSON.stringify(row)],
      ...(extras.rows ?? []).map((extra): Command => ["RPUSH", key("audit"), JSON.stringify(extra)]),
    ];
    if (extras.listed !== undefined) commands.push(["SET", key("listed"), extras.listed ? "1" : "0"]);
    if (extras.stage !== undefined) commands.push(["SET", key("stage"), String(extras.stage)]);
    await run(commands, true);
    return true;
  } catch (error) {
    await release(claimName);
    throw error;
  }
}

/**
 * Writes the two opening agent rows once per reset. Returns false and writes nothing when
 * the audit list is not empty or another request holds the guard. Both rows go in one
 * MULTI/EXEC; a failed write releases the guard.
 */
export async function commitOpeningRows(rows: DemoAuditRow[]): Promise<boolean> {
  if (rows.length === 0) return false;
  if (!(await claim("opening"))) return false;
  try {
    const [existing] = await run([["LRANGE", key("audit"), 0, 0]]);
    if (Array.isArray(existing) && existing.length > 0) return false;
    await run(rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]), true);
    return true;
  } catch (error) {
    await release("opening");
    throw error;
  }
}

export async function appendAudit(row: DemoAuditRow): Promise<void> {
  await run([["RPUSH", key("audit"), JSON.stringify(row)]]);
}

/** Appends several audit rows in one request, so readers never see only some of them. */
export async function appendAuditRows(rows: DemoAuditRow[]): Promise<void> {
  if (rows.length === 0) return;
  await run(rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]));
}

/** Appends audit rows and moves the stage in one request, so a reader never sees the rows without the stage. */
export async function appendAuditRowsAndSetStage(rows: DemoAuditRow[], stage: number): Promise<void> {
  if (!Number.isInteger(stage) || stage < MIN_STAGE || stage > MAX_STAGE) throw new Error("Demo stage out of range");
  await run([...rows.map((row): Command => ["RPUSH", key("audit"), JSON.stringify(row)]), ["SET", key("stage"), String(stage)]]);
}

/**
 * Deletes the fixed key list (no SCAN, no wildcards) and reseeds stage 0 with
 * nothing approved and nothing listed.
 */
export async function resetDemo(): Promise<DemoState> {
  await run(
    [
      ...STATE_KEY_NAMES.map((name): Command => ["DEL", key(name)]),
      ["SET", key("stage"), "0"],
      ["SET", key("listed"), "0"],
    ],
    true,
  );
  return { stage: MIN_STAGE, approvals: {}, audit: [], listed: false };
}
