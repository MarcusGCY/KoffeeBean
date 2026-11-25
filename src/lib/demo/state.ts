import { redisPipeline } from "../upstash";

/** Every Redis key the Pelita demo track touches lives under this prefix. */
export const KEY_PREFIX = "kb:demo:pelita:";

/** The complete, fixed set of state keys. Reset deletes exactly these. */
export const STATE_KEY_NAMES = ["stage", "approvals", "audit", "listed"] as const;
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

/**
 * Every demo write and read goes through here. Each command names exactly one
 * key, and it must be inside the demo prefix and on the fixed list.
 */
async function run(commands: Command[]): Promise<unknown[]> {
  for (const command of commands) {
    const [name, target] = command;
    if (typeof name !== "string" || !COMMANDS.has(name)) throw new Error("Demo store command not allowed");
    if (typeof target !== "string" || !target.startsWith(KEY_PREFIX) || !STATE_KEYS.includes(target)) {
      throw new Error("Demo store key outside the demo prefix");
    }
  }
  return redisPipeline(commands);
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

/**
 * Records one approval and its audit row in a single request. Returns false and
 * writes nothing when the slot already holds an approval. The check is made just
 * before the write: the shared approvals key has no compare-and-set on the fixed
 * command list, so two truly simultaneous requests could still both pass.
 */
export async function commitApproval(slot: ApprovalSlot, approval: DemoApproval, row: DemoAuditRow): Promise<boolean> {
  const [current] = await run([["GET", key("approvals")]]);
  const approvals = parseApprovals(current);
  if (approvals[slot]) return false;
  await run([
    ["SET", key("approvals"), JSON.stringify({ ...approvals, [slot]: approval })],
    ["RPUSH", key("audit"), JSON.stringify(row)],
  ]);
  return true;
}

export async function appendAudit(row: DemoAuditRow): Promise<void> {
  await run([["RPUSH", key("audit"), JSON.stringify(row)]]);
}

/**
 * Deletes the fixed key list (no SCAN, no wildcards) and reseeds stage 0 with
 * nothing approved and nothing listed.
 */
export async function resetDemo(): Promise<DemoState> {
  await run([
    ...STATE_KEY_NAMES.map((name): Command => ["DEL", key(name)]),
    ["SET", key("stage"), "0"],
    ["SET", key("listed"), "0"],
  ]);
  return { stage: MIN_STAGE, approvals: {}, audit: [], listed: false };
}
