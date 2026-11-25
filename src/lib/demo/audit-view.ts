import { SEND_BACK_ACTION_PREFIX, launchPhase, launchRail } from "./approval-view";
import { EDIT_ACTION_PREFIX, SEND_ACTION } from "./listing-view";
import { CONSOLE_TITLE, REJECT_ACTION_PREFIX, railSteps, type RailStep } from "./ops-console";
import { publishedView } from "./published-view";
import type { Scenario } from "./scenario";
import type { DemoAuditRow, DemoState } from "./state";
import { findStockCheck } from "./stock-check-view";

export const AUDIT_FOOTER = "Nothing reaches shoppers without two human approvals. Every step the agent takes after the proposal is logged here.";
export const EMPTY_LABEL = "Nothing is logged yet. Steps appear here as the launch moves along.";
export const UNAVAILABLE_LABEL = "The audit store could not be read. Try again in a moment.";

/** An approval is a human audit row whose ref starts with this prefix. Edits and sends carry the listing ref instead. */
export const APPROVAL_REF_PREFIX = "APR-";

const NO_VALUE = "—";

type AuditState = Pick<DemoState, "stage" | "approvals" | "audit" | "listed">;

export type AuditKind = "agent" | "human" | "system";
export type HumanKind = "approval" | "edit" | "send" | "send_back" | "reject" | "other";

export type AuditChange = { label: string; before: string; after: string; note: string | null };

export type AuditEntry = {
  key: string;
  kind: AuditKind;
  /** Hours, minutes and seconds in Singapore time. */
  timeLabel: string;
  actor: string;
  action: string;
  source: string;
  ref: string | null;
  /** Set for human rows only. Only `approval` is an approval. */
  humanKind: HumanKind | null;
  humanLabel: string | null;
  change: AuditChange | null;
};

export type AuditCount = { count: number; label: string };

export type AuditView = {
  isDemo: true;
  demoTag: string;
  consoleTitle: string;
  brand: { wordmark: string; wordmarkSub: string };
  person: { name: string; initials: string; role: string };
  steps: RailStep[];
  title: string;
  detectedLabel: string;
  unavailable: boolean;
  entries: AuditEntry[];
  agent: AuditCount;
  approvals: AuditCount & { refs: string[] };
  /** Edit, send, send-back and rejection rows: human, but not approvals. Null when there are none. */
  otherHuman: AuditCount | null;
  elapsed: { pill: string; detail: string } | null;
  notLiveLabel: string;
  footer: string;
  emptyLabel: string;
  unavailableLabel: string;
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : NO_VALUE;
}

function kindOf(value: unknown): AuditKind {
  return value === "agent" || value === "human" ? value : "system";
}

/** "09:02:10" in Singapore time, whatever zone the server runs in. */
export function clockSecondsLabel(iso: unknown): string {
  const date = new Date(typeof iso === "string" ? iso : "");
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Singapore",
  }).format(date);
}

/** The approval ref of a row (`APR-` and digits), or null. Only human rows can carry one. */
export function approvalRef(row: Pick<DemoAuditRow, "actorKind" | "ref">): string | null {
  if (row.actorKind !== "human" || typeof row.ref !== "string") return null;
  const digits = row.ref.startsWith(APPROVAL_REF_PREFIX) ? row.ref.slice(APPROVAL_REF_PREFIX.length) : "";
  return /^\d+$/.test(digits) ? row.ref : null;
}

/** Distinct approval refs in the order they were logged. A ref repeated on the list counts once. */
export function approvalRefs(rows: readonly Pick<DemoAuditRow, "actorKind" | "ref">[]): string[] {
  const refs: string[] = [];
  for (const row of rows) {
    const ref = approvalRef(row);
    if (ref !== null && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function humanKindOf(row: DemoAuditRow): HumanKind {
  if (approvalRef(row) !== null) return "approval";
  const action = typeof row.action === "string" ? row.action : "";
  if (action.startsWith(EDIT_ACTION_PREFIX)) return "edit";
  if (action === SEND_ACTION) return "send";
  if (action.startsWith(SEND_BACK_ACTION_PREFIX)) return "send_back";
  if (action.startsWith(REJECT_ACTION_PREFIX)) return "reject";
  return "other";
}

const HUMAN_LABELS: Record<Exclude<HumanKind, "approval">, string> = {
  edit: "Human edit",
  send: "Human send",
  send_back: "Human send-back",
  reject: "Human rejection",
  other: "Human action",
};

/** The product's short name for the title: the listing title up to its first number. */
function shortName(title: string): string {
  const cut = title.search(/\s\d/);
  return (cut > 0 ? title.slice(0, cut) : title).trim();
}

function entryFor(scenario: Scenario, row: DemoAuditRow, index: number, currentDescription: { text: string }): AuditEntry {
  const kind = kindOf(row.actorKind);
  const ref = typeof row.ref === "string" && row.ref !== "" ? row.ref : null;
  const base = {
    key: `${index}-${row.at}`,
    kind,
    timeLabel: clockSecondsLabel(row.at),
    actor: text(row.actor),
    source: text(row.source),
    ref,
  };
  const action = text(row.action);

  if (kind === "human") {
    const humanKind = humanKindOf(row);
    const slot = scenario.approvers.find((a) => a.approvalId === ref)?.slot;
    const humanLabel = humanKind === "approval" ? (slot ? `Approval ${slot} of ${scenario.approvers.length}` : "Approval") : HUMAN_LABELS[humanKind];
    if (humanKind === "edit") {
      const after = action.slice(EDIT_ACTION_PREFIX.length).replace(/^:\s*/, "");
      const change: AuditChange | null = after ? { label: "Description", before: currentDescription.text, after, note: null } : null;
      if (after) currentDescription.text = after;
      return { ...base, action: EDIT_ACTION_PREFIX, humanKind, humanLabel, change };
    }
    return { ...base, action, humanKind, humanLabel, change: null };
  }

  const { claimsCheck } = scenario;
  const claimsRow = kind === "agent" && ref === claimsCheck.id && claimsCheck.removed.length > 0;
  const change: AuditChange | null = claimsRow
    ? {
        label: "Claim",
        before: claimsCheck.removed.map((r) => r.claim).join(", "),
        after: claimsCheck.kept.join(", "),
        note: claimsCheck.removed.map((r) => r.reason).join(", "),
      }
    : null;
  return { ...base, action, humanKind: null, humanLabel: null, change };
}

/** Step 7 is the screen being read. Steps that really finished stay done, and a step still in progress shows as not done yet. */
function auditRail(scenario: Scenario, state: AuditState): RailStep[] {
  const phase = launchPhase(scenario, state);
  const base = phase === "launched" ? railSteps(7) : launchRail(phase, false, findStockCheck(scenario, state) !== null);
  return base.map((step) => (step.n === 7 ? { ...step, state: "current" as const } : step.state === "current" ? { ...step, state: "upcoming" as const } : step));
}

/**
 * Everything screen 07 renders. `state` is null when the store could not be read, which
 * shows an unavailable notice instead of an empty trail. The rows come only from the
 * persisted audit list, in the order they were written. The detection-to-live time is the
 * fixture's, and shows only once approval 2 has really published.
 */
export function auditView(scenario: Scenario, state: AuditState | null): AuditView {
  const rows = state?.audit ?? [];
  const description = { text: scenario.listing.description };
  const entries = rows.map((row, index) => entryFor(scenario, row, index, description));
  const refs = approvalRefs(rows);
  const agentCount = entries.filter((e) => e.kind === "agent").length;
  const otherHumanCount = entries.filter((e) => e.humanKind !== null && e.humanKind !== "approval").length;
  const person = scenario.approvers.find((a) => a.slot === 2) ?? scenario.approvers[0];
  const published = state ? publishedView(scenario, state) : null;
  const empty: AuditState = { stage: 0, approvals: {}, audit: [], listed: false };

  return {
    isDemo: true,
    demoTag: scenario.demoTag,
    consoleTitle: CONSOLE_TITLE,
    brand: { wordmark: scenario.brand.wordmark, wordmarkSub: scenario.brand.wordmarkSub },
    person: { name: person.name, initials: person.initials, role: person.role },
    steps: auditRail(scenario, state ?? empty),
    title: `Audit trail · ${shortName(scenario.listing.title)}`,
    detectedLabel: scenario.gap.detectedLabel,
    unavailable: state === null,
    entries,
    agent: { count: agentCount, label: plural(agentCount, "agent step") },
    approvals: { count: refs.length, refs, label: plural(refs.length, "human approval") },
    otherHuman: otherHumanCount > 0 ? { count: otherHumanCount, label: `${plural(otherHumanCount, "other human action")} · not approvals` } : null,
    elapsed: published ? { pill: `${scenario.timing.totalLabel}, gap to live`, detail: published.liveIn } : null,
    notLiveLabel: "Not live yet",
    footer: AUDIT_FOOTER,
    emptyLabel: EMPTY_LABEL,
    unavailableLabel: UNAVAILABLE_LABEL,
  };
}
