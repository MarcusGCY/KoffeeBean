import { hasFixMerged, parseFixResult, parseFixRun } from "./fix-marker";
import * as gh from "./github";
import {
  buildEvent,
  deliveryAck,
  parseAudit,
  parseCase,
  redactAudit,
  sealEvent,
  severityLine,
  type AckBinding,
  type NotifyDelivery,
  type QualityCase,
  type QualityEvent,
} from "./quality-case";
import { parseRepro } from "./reproduce";

export type StageView = {
  stage: string;
  status: string;
  at: string | null;
  actor: string;
  source: "recorded" | "reconstructed";
  actionId: string | null;
  issue: number | null;
  pr: number | null;
  agentId: string | null;
  runId: string | null;
  evidence: string | null;
  error: string | null;
  attempt: number | null;
  nextOwner: string;
  blocker: string | null;
  externalAck: "none" | "delivered" | "acknowledged";
  severity: string | null;
  reason: string | null;
  category: string | null;
  head: string | null;
  decision: "adopt" | "go" | "no-go" | null;
  atKind: "source" | "written" | "unknown";
};

export type QualityAudit = {
  issue: number;
  title: string;
  state: string;
  labels: string[];
  caseId: string | null;
  correlationId: string | null;
  severity: string | null;
  reason: string | null;
  category: string | null;
  severityLine: string;
  stages: StageView[];
  unresolved: { stage: string; owner: string; blocker: string }[];
  next: { stage: string; owner: string; blocker: string } | null;
  tracking: {
    appLauncher: "single";
    fixLaunched: boolean;
    engineeringAdoption: "adopted" | "unacknowledged" | "not_applicable";
    verification: "go" | "no_go" | "stale" | "unacknowledged" | "not_applicable";
    notifyFixStarted: "not_recorded" | NotifyDelivery;
    notifyFixCompleted: "not_recorded" | NotifyDelivery;
    notifyFixMerged: "not_recorded" | NotifyDelivery;
    verificationAcceptsPullRequestSelfReport: false;
  };
  external: {
    grokRoom: string;
    engineeringChat: string;
    triageChat: string;
    actions: string;
    vercelDeploy: string;
  };
  limits: string[];
};

const LIMITS = [
  "The app is the only launcher. Engineering adoption is not a launch. Opening a quality URL records nothing.",
  "A verification GO is an admin POST with evidence for one pull request head. ACK is not GO. NO-GO and missing evidence are not a pass. A later push invalidates a GO.",
  "Webhook HTTP success is delivery to the routine URL. It is not a room acknowledgement.",
  "This app does not observe the Grok room, Engineering chat, or Triage chat. The Quality room has to route verification.",
  "Audit comments sit on the GitHub issue. On a public repository they are public, not a confidential store.",
  "Duplicate suppression reads comments and then writes. Concurrent POSTs can both write. There is no atomic ledger and no background outbox.",
  "A failed audit write is not retried later. The response says nothing was saved. A missing comment is not proof the stage failed, and this trail is not an all-points log.",
  "atKind source is a time captured for that step. atKind written is when the comment was saved. atKind unknown means no original time was stored. Pre-issue holds and triage failures are not durable.",
  "A pull request body's own test report is not verification. Vercel deploy after merge is not observed by this app.",
  "GET /api/review still approves and starts the one fix. GET /api/quality/ack does not.",
];

const EXTERNAL = {
  grokRoom: "not observed by this app",
  engineeringChat: "not observed by this app",
  triageChat: "not observed by this app",
  actions: "observed only when a reproduction check URL or a recorded repro event is present",
  vercelDeploy: "not observed by this app",
};

const RECOVERY = "Retry the write. Nothing was saved. This app has no background outbox.";

export type AuditWriteResult = {
  recorded: boolean;
  duplicate: boolean;
  actionId: string;
  issue: number;
  caseId: string | null;
  stage: string;
  dedup: "check_then_write";
  error?: "github_write_failed" | "issue_mismatch";
  recovery?: string;
};

export async function recordQualityEvent(issue: number, event: QualityEvent): Promise<AuditWriteResult> {
  const base = {
    actionId: event.actionId,
    issue,
    caseId: event.caseId,
    stage: event.stage,
    dedup: "check_then_write" as const,
  };
  if (event.issue !== issue) {
    console.error(`[quality] audit_write_rejected issue=${issue} eventIssue=${event.issue ?? "none"} case=${event.caseId ?? "none"} action=${event.actionId} stage=${event.stage} error=issue_mismatch`);
    return { ...base, recorded: false, duplicate: false, error: "issue_mismatch", recovery: RECOVERY };
  }
  try {
    const comments = await gh.listComments(issue);
    const existing = comments
      .map((comment) => parseAudit(comment.body))
      .find((found) => found?.actionId === event.actionId && found.issue === issue);
    if (existing) return { ...base, recorded: true, duplicate: true };
    await gh.comment(issue, sealEvent(event));
    return { ...base, recorded: true, duplicate: false };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[quality] audit_write_failed issue=${issue} case=${event.caseId ?? "none"} action=${event.actionId} stage=${event.stage} error=github_write_failed name=${name}`);
    return { ...base, recorded: false, duplicate: false, error: "github_write_failed", recovery: RECOVERY };
  }
}

export async function recordOpenedCase(input: {
  issue: number;
  quality: QualityCase;
  triageAgentId?: string;
  triageRunId?: string;
  branch?: string;
  testPath?: string;
  sha?: string;
  checkUrl?: string;
  intakeDelivery: NotifyDelivery;
  intakeAt?: string;
  triageAt?: string;
  repro: "pending" | "reproduced" | "not_reproduced" | "error";
  reproError?: string;
  reviewDelivery?: NotifyDelivery;
}): Promise<void> {
  const writtenAt = new Date().toISOString();
  const intakeAt = input.intakeAt ?? writtenAt;
  const triageAt = input.triageAt ?? writtenAt;
  const base = {
    caseId: input.quality.caseId,
    correlationId: input.quality.correlationId,
    issue: input.issue,
    severity: input.quality.severity,
    reason: input.quality.reason,
    category: input.quality.category,
    attempt: 1,
  };
  await recordQualityEvent(input.issue, buildEvent({
    ...base,
    actionId: `intake:${input.quality.caseId}`,
    stage: "intake",
    status: "recorded",
    at: intakeAt,
    atKind: input.intakeAt ? "source" : "written",
    actor: "app",
    pr: null,
    agentId: null,
    runId: null,
    evidence: `delivery ${input.intakeDelivery}`,
    nextOwner: "app",
    blocker: null,
    externalAck: deliveryAck(input.intakeDelivery),
  }));
  await recordQualityEvent(input.issue, buildEvent({
    ...base,
    actionId: `triage:${input.quality.caseId}:${input.triageRunId ?? "none"}`,
    stage: "triage",
    status: "recorded",
    at: triageAt,
    atKind: input.triageAt ? "source" : "written",
    actor: input.triageAgentId ? "cursor_agent" : "app",
    pr: null,
    agentId: input.triageAgentId ?? null,
    runId: input.triageRunId ?? null,
    evidence: input.triageAgentId
      ? `branch ${input.branch ?? "unknown"} test ${input.testPath ?? "unknown"}`
      : "triage agent id was not stored",
    nextOwner: "github_actions",
    blocker: input.repro === "pending" ? "reproduction check has not finished" : null,
    externalAck: "none",
  }));
  await recordQualityEvent(input.issue, buildEvent({
    ...base,
    actionId: `repro:${input.quality.caseId}:${input.sha ?? "none"}:${input.repro}`,
    stage: "repro",
    status: input.repro,
    at: writtenAt,
    atKind: "written",
    actor: input.checkUrl ? "github_actions" : "app",
    pr: null,
    agentId: null,
    runId: null,
    evidence: input.checkUrl
      ? `check ${input.checkUrl} sha ${input.sha ?? "unknown"}`
      : `sha ${input.sha ?? "unknown"} test ${input.testPath ?? "unknown"}`,
    error: input.reproError ?? null,
    nextOwner: input.repro === "reproduced" ? "human" : input.repro === "pending" ? "app" : "none",
    blocker: input.repro === "reproduced"
      ? "waiting for signed approval"
      : input.repro === "pending"
        ? "reproduction check has not finished"
        : null,
    externalAck: "none",
  }));
  if (input.reviewDelivery) {
    await recordQualityEvent(input.issue, buildEvent({
      ...base,
      actionId: `review_delivery:${input.issue}`,
      stage: "review_delivery",
      status: input.reviewDelivery === "failed" ? "undelivered" : input.reviewDelivery,
      at: writtenAt,
      atKind: "written",
      actor: "app",
      pr: null,
      agentId: null,
      runId: null,
      evidence: `review_request ${input.reviewDelivery}`,
      error: input.reviewDelivery === "failed" ? "webhook_failed" : null,
      nextOwner: "human",
      blocker: "waiting for signed approval",
      externalAck: deliveryAck(input.reviewDelivery),
    }));
  }
}

export function caseFields(quality: QualityCase | null | undefined) {
  return {
    caseId: quality?.caseId ?? null,
    correlationId: quality?.correlationId ?? null,
    severity: quality?.severity ?? null,
    reason: quality?.reason ?? null,
    category: quality?.category ?? null,
  };
}

export async function loadQualityAudit(issue: number): Promise<QualityAudit> {
  let current: Awaited<ReturnType<typeof gh.getIssue>>;
  try {
    current = await gh.getIssue(issue);
  } catch (error) {
    if (gh.githubHttpStatus(error) === 404) {
      const missing = new Error("not found");
      (missing as Error & { status?: number }).status = 404;
      throw missing;
    }
    throw error;
  }
  const comments = await gh.listComments(issue);
  let currentPr: number | null = null;
  for (const item of comments) {
    const meta = parseFixResult(item.body);
    if (meta?.prNumber) currentPr = meta.prNumber;
  }
  let currentHead: string | null = null;
  if (currentPr) {
    try {
      const pull = await gh.getPullRequest(currentPr);
      currentHead = pull?.headSha ?? null;
    } catch (error) {
      console.error(`[quality] head_read_failed issue=${issue} pr=${currentPr} case=${parseCase(current.body, issue)?.caseId ?? "none"} error=github_read_failed name=${error instanceof Error ? error.name : "Error"}`);
      currentHead = null;
    }
  }
  return assembleAudit({
    number: current.number,
    title: current.title,
    body: current.body,
    currentHead,
    currentPr,
    state: current.state,
    labels: current.labels,
    comments: comments.map((comment) => ({ body: comment.body })),
  });
}

export function assembleAudit(input: {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: { body: string }[];
  currentHead?: string | null;
  currentPr?: number | null;
}): QualityAudit {
  const quality = parseCase(input.body, input.number);
  const recorded = input.comments
    .map((comment) => parseAudit(comment.body))
    .filter((event): event is QualityEvent => Boolean(event && event.issue === input.number))
    .sort((a, b) => a.at.localeCompare(b.at));
  const stages = mergeStages(input, recorded);
  const hasLaunch = stages.some((stage) => stage.stage === "fix_launch");
  const runId = stages.find((stage) => stage.stage === "fix_launch" && stage.runId)?.runId ?? null;
  const engAck = recorded.some((event) =>
    event.stage === "engineering_ack"
    && event.decision === "adopt"
    && (runId == null || event.runId === runId));
  const pr = input.currentPr ?? latestPr(stages);
  const head = input.currentHead ?? null;
  const verdict = verificationVerdict(recorded, pr, head);
  const verGo = verdict === "go";
  const merged = input.labels.includes("merged") || stages.some((stage) => stage.stage === "merge");
  const unresolved: QualityAudit["unresolved"] = [];
  if (!hasLaunch && engAck) {
    unresolved.push({
      stage: "fix_launch",
      owner: "app",
      blocker: "fix not launched; acknowledgement does not launch an agent",
    });
  }
  if (hasLaunch && !engAck) {
    unresolved.push({
      stage: "engineering_ack",
      owner: "engineering",
      blocker: "adoption is not recorded for this run; adoption is not a launch and not a GO",
    });
  }
  if (pr && !verGo) {
    unresolved.push({
      stage: "verification",
      owner: "verification",
      blocker: verdict === "no_go"
        ? "verification NO-GO for this head; NO-GO is not a pass"
        : verdict === "stale"
          ? "a GO for a previous head does not cover the current head"
          : "verification GO is not recorded; opening a link is not a GO",
    });
  }
  if (pr && verGo && !merged && input.state === "open") {
    unresolved.push({
      stage: "merge",
      owner: "human",
      blocker: "signed merge not completed",
    });
  }
  if (merged) {
    unresolved.push({
      stage: "deploy",
      owner: "vercel",
      blocker: "deploy not observed by this app",
    });
  }
  if (!hasLaunch && !engAck && input.labels.includes("awaiting-review")) {
    unresolved.push({
      stage: "approval",
      owner: "human",
      blocker: "waiting for signed approval",
    });
  }
  if (input.labels.includes("repro-pending") && !stages.some((stage) => stage.stage === "repro" && stage.status === "reproduced")) {
    unresolved.push({
      stage: "repro",
      owner: "app",
      blocker: "reproduction check has not finished",
    });
  }
  const next = chooseNext(unresolved, pr);
  const severity = quality?.severity ?? recorded.find((event) => event.severity)?.severity ?? null;
  const reason = quality?.reason ?? recorded.find((event) => event.reason)?.reason ?? null;
  const category = quality?.category ?? recorded.find((event) => event.category)?.category ?? null;
  return {
    issue: input.number,
    title: redactAudit(input.title).slice(0, 200),
    state: input.state,
    labels: input.labels.filter((label) => /^[a-z0-9-]+$/.test(label)),
    caseId: quality?.caseId ?? recorded.find((event) => event.caseId)?.caseId ?? null,
    correlationId: quality?.correlationId ?? recorded.find((event) => event.correlationId)?.correlationId ?? null,
    severity,
    reason,
    category,
    severityLine: severityLine({ severity, category, reason }),
    stages,
    unresolved,
    next,
    tracking: {
      appLauncher: "single",
      fixLaunched: hasLaunch,
      engineeringAdoption: engAck ? "adopted" : hasLaunch ? "unacknowledged" : "not_applicable",
      verification: verdict === "go"
        ? "go"
        : verdict === "no_go"
          ? "no_go"
          : verdict === "stale"
            ? "stale"
            : pr ? "unacknowledged" : "not_applicable",
      notifyFixStarted: notifyState(recorded, "notify_fix_started"),
      notifyFixCompleted: notifyState(recorded, "notify_fix_completed"),
      notifyFixMerged: notifyState(recorded, "notify_fix_merged"),
      verificationAcceptsPullRequestSelfReport: false,
    },
    external: EXTERNAL,
    limits: LIMITS,
  };
}

function verificationVerdict(
  events: QualityEvent[],
  pr: number | null,
  head: string | null,
): "go" | "no_go" | "stale" | "none" {
  const decisions = events.filter((event) => event.stage === "verification" && event.decision);
  const usable = (event: QualityEvent) => event.decision !== "go" || Boolean(event.evidence?.trim());
  if (!pr || !head) return decisions.some((event) => event.decision === "go" && usable(event)) ? "stale" : "none";
  const current = decisions
    .filter((event) => event.pr === pr && event.head === head && usable(event))
    .sort((a, b) => a.at.localeCompare(b.at));
  const latest = current.at(-1);
  if (!latest) return decisions.some((event) => event.decision === "go" && usable(event)) ? "stale" : "none";
  if (latest.decision === "no-go") return "no_go";
  if (latest.decision === "go") return "go";
  return "none";
}

function chooseNext(
  unresolved: QualityAudit["unresolved"],
  pr: number | null,
): QualityAudit["next"] {
  const pick = (stage: string) => unresolved.find((item) => item.stage === stage) ?? null;
  if (pr) {
    return pick("verification") ?? pick("merge") ?? pick("deploy") ?? pick("engineering_ack");
  }
  return pick("fix_launch") ?? pick("engineering_ack") ?? pick("approval") ?? pick("repro") ?? unresolved[0] ?? null;
}

function latestPr(stages: StageView[]): number | null {
  let pr: number | null = null;
  for (const stage of stages) {
    if (stage.pr) pr = stage.pr;
  }
  return pr;
}

function notifyState(events: QualityEvent[], stage: string): "not_recorded" | NotifyDelivery {
  const found = [...events].reverse().find((event) => event.stage === stage);
  if (!found) return "not_recorded";
  if (found.status === "delivered" || found.status === "skipped" || found.status === "undelivered") {
    return found.status === "undelivered" ? "failed" : found.status;
  }
  return "not_recorded";
}

function mergeStages(
  input: { number: number; body: string; labels: string[]; comments: { body: string }[] },
  recorded: QualityEvent[],
): StageView[] {
  const views = recorded.map(toView);
  const seen = new Set(views.map((view) => view.stage));
  for (const extra of reconstruct(input)) {
    if (seen.has(extra.stage)) continue;
    seen.add(extra.stage);
    views.push(extra);
  }
  const order = [
    "intake", "triage", "repro", "review_delivery", "approval", "fix_launch",
    "notify_fix_started", "engineering_ack", "fix_result", "notify_fix_completed",
    "verification", "merge", "notify_fix_merged",
  ];
  return views.sort((a, b) => {
    const left = order.indexOf(a.stage);
    const right = order.indexOf(b.stage);
    return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
  });
}

function reconstruct(input: {
  number: number;
  body: string;
  labels: string[];
  comments: { body: string }[];
}): StageView[] {
  const stages: StageView[] = [];
  const repro = parseRepro(input.body);
  if (repro) {
    const check = input.body.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+/)?.[0] ?? null;
    stages.push(view({
      stage: "repro",
      status: "reproduced",
      at: null,
      atKind: "unknown",
      actor: check ? "github_actions" : "app",
      issue: input.number,
      evidence: check ? `check ${check} sha ${repro.sha}` : `sha ${repro.sha} test ${repro.testPath}`,
      nextOwner: "human",
      blocker: "waiting for signed approval",
      externalAck: "none",
    }));
  }
  if (input.labels.includes("approved")) {
    stages.push(view({
      stage: "approval",
      status: "recorded",
      at: null,
      atKind: "unknown",
      actor: "app",
      issue: input.number,
      evidence: "label approved",
      nextOwner: "app",
      blocker: null,
      externalAck: "none",
    }));
  }
  for (const comment of input.comments) {
    const run = parseFixRun(comment.body);
    if (!run) continue;
    stages.push(view({
      stage: "fix_launch",
      status: "launched",
      at: Number.isFinite(run.startedAt) ? new Date(run.startedAt).toISOString() : null,
      atKind: Number.isFinite(run.startedAt) ? "source" : "unknown",
      actor: "cursor_agent",
      issue: input.number,
      agentId: run.agentId,
      runId: run.runId,
      evidence: "fix run marker",
      nextOwner: "engineering",
      blocker: "adoption not acknowledged; do not launch another fix",
      externalAck: "none",
    }));
    break;
  }
  for (const comment of input.comments) {
    if (!comment.body.includes("beanbox-fix-result")) continue;
    const meta = parseFixResult(comment.body);
    stages.push(view({
      stage: "fix_result",
      status: "opened",
      at: null,
      atKind: "unknown",
      actor: "cursor_agent",
      issue: input.number,
      pr: meta?.prNumber ?? null,
      evidence: meta?.prUrl ? `pull request recorded` : "fix result marker without a pull request url",
      nextOwner: meta?.prNumber ? "verification" : "app",
      blocker: meta?.prNumber
        ? "independent verification not acknowledged; pull request test report is not verification"
        : null,
      externalAck: "none",
    }));
    break;
  }
  if (input.labels.includes("merged") || input.comments.some((comment) => hasFixMerged(comment.body))) {
    stages.push(view({
      stage: "merge",
      status: "merged",
      at: null,
      atKind: "unknown",
      actor: "app",
      issue: input.number,
      evidence: "merge marker or merged label",
      nextOwner: "vercel",
      blocker: "deploy not observed by this app",
      externalAck: "none",
    }));
  }
  return stages;
}

function toView(event: QualityEvent): StageView {
  return {
    stage: event.stage,
    status: event.status,
    at: event.at,
    actor: event.actor,
    source: "recorded",
    actionId: event.actionId,
    issue: event.issue,
    pr: event.pr,
    agentId: event.agentId,
    runId: event.runId,
    evidence: event.evidence,
    error: event.error,
    attempt: event.attempt,
    nextOwner: event.nextOwner,
    blocker: event.blocker,
    externalAck: event.externalAck,
    severity: event.severity,
    reason: event.reason,
    category: event.category,
    head: event.head,
    decision: event.decision,
    atKind: event.atKind,
  };
}

function view(input: Omit<StageView, "source" | "actionId" | "pr" | "agentId" | "runId" | "error" | "attempt" | "severity" | "reason" | "category" | "head" | "decision"> & {
  pr?: number | null;
  agentId?: string | null;
  runId?: string | null;
}): StageView {
  return {
    ...input,
    source: "reconstructed",
    actionId: null,
    pr: input.pr ?? null,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    error: null,
    attempt: null,
    severity: null,
    reason: null,
    category: null,
    head: null,
    decision: null,
    atKind: input.atKind,
  };
}

export class QualityDecisionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "QualityDecisionError";
    this.status = status;
    this.code = code;
  }
}

export async function recordQualityDecision(input: {
  binding: AckBinding;
  decision: "adopt" | "go" | "no-go";
  evidence: string;
  verifierRef: string;
  currentHead: string | null;
}): Promise<{ audit: QualityAudit; write: AuditWriteResult }> {
  const binding = input.binding;
  if (binding.stage === "engineering" && input.decision !== "adopt") {
    throw new QualityDecisionError(400, "bad_decision", "Engineering adoption only records adopt. Nothing was recorded.");
  }
  if (binding.stage === "verification" && input.decision === "adopt") {
    throw new QualityDecisionError(400, "bad_decision", "Verification records go or no-go. Nothing was recorded.");
  }
  const evidence = redactAudit(input.evidence).trim();
  if (input.decision === "go" && !evidence) {
    throw new QualityDecisionError(400, "evidence_required", "A GO requires evidence. Nothing was recorded.");
  }
  if (binding.stage === "verification") {
    if (!binding.pr || binding.head === "-") {
      throw new QualityDecisionError(409, "unbound_head", "Verification is not bound to a pull request head. Nothing was recorded.");
    }
    if (!input.currentHead || input.currentHead !== binding.head) {
      throw new QualityDecisionError(409, "head_moved", "The pull request head does not match this link. Nothing was recorded.");
    }
  }
  const current = await gh.getIssue(binding.issue);
  const quality = parseCase(current.body, binding.issue);
  if (binding.caseId !== "-" && quality && quality.caseId !== binding.caseId) {
    throw new QualityDecisionError(409, "case_mismatch", "This link is for a different case. Nothing was recorded.");
  }
  const comments = await gh.listComments(binding.issue);
  const prefix = `decision:${binding.issue}:${binding.caseId}:${binding.stage}:${binding.runId}:${binding.pr}:${binding.head}:${input.decision}:`;
  const attempt = 1 + comments
    .map((comment) => parseAudit(comment.body))
    .filter((event) => event?.issue === binding.issue && event.actionId.startsWith(prefix)).length;
  const stageName = binding.stage === "engineering" ? "engineering_ack" : "verification";
  const write = await recordQualityEvent(binding.issue, buildEvent({
    actionId: `${prefix}${attempt}`,
    caseId: quality?.caseId ?? (binding.caseId === "-" ? null : binding.caseId),
    correlationId: quality?.correlationId ?? (binding.caseId === "-" ? null : binding.caseId),
    stage: stageName,
    status: input.decision === "no-go" ? "no_go" : input.decision === "go" ? "go" : "adopted",
    at: new Date().toISOString(),
    atKind: "source",
    actor: "admin",
    issue: binding.issue,
    pr: binding.pr > 0 ? binding.pr : null,
    agentId: null,
    runId: binding.runId === "-" ? null : binding.runId,
    severity: quality?.severity ?? null,
    reason: quality?.reason ?? null,
    category: quality?.category ?? null,
    evidence: evidence || null,
    attempt,
    nextOwner: input.decision === "go" ? "human" : "verification",
    blocker: input.decision === "go"
      ? "signed merge not completed"
      : input.decision === "no-go"
        ? "verification NO-GO; not a pass"
        : "adoption is not a launch and not a verification GO",
    externalAck: "none",
    head: binding.head === "-" ? null : binding.head,
    decision: input.decision,
    verifierRef: input.verifierRef,
  }));
  if (!write.recorded) {
    throw new QualityDecisionError(503, write.error ?? "audit_write_failed", write.recovery ?? "Nothing was recorded.");
  }
  return { audit: await loadQualityAudit(binding.issue), write };
}
