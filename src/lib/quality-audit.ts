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
    engineeringAdoption: "acknowledged" | "unacknowledged" | "not_applicable";
    verification: "acknowledged" | "acknowledged_before_pull_request" | "unacknowledged" | "not_applicable";
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
  "The app is the only launcher. An adoption or verification link does not start an agent and does not merge.",
  "Webhook HTTP success is delivery to the routine URL. It is not a room acknowledgement.",
  "This app does not observe the Grok room, Engineering chat, or Triage chat.",
  "A pull request body's own test report is not verification.",
  "Vercel deploy after merge is not observed by this app.",
  "Issues that predate audit comments are reconstructed from GitHub markers. Missing webhook results stay not recorded.",
];

const EXTERNAL = {
  grokRoom: "not observed by this app",
  engineeringChat: "not observed by this app",
  triageChat: "not observed by this app",
  actions: "observed only when a reproduction check URL or a recorded repro event is present",
  vercelDeploy: "not observed by this app",
};

export async function recordQualityEvent(
  issue: number,
  event: QualityEvent,
): Promise<"recorded" | "duplicate" | "failed"> {
  try {
    const comments = await gh.listComments(issue);
    if (comments.some((comment) => parseAudit(comment.body)?.actionId === event.actionId)) return "duplicate";
    await gh.comment(issue, sealEvent(event));
    return "recorded";
  } catch (error) {
    console.error("[quality] audit write failed", error instanceof Error ? error.name : "Error");
    return "failed";
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
  repro: "pending" | "reproduced" | "not_reproduced" | "error";
  reproError?: string;
  reviewDelivery?: NotifyDelivery;
}): Promise<void> {
  const at = new Date().toISOString();
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
    at,
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
    actionId: `triage:${input.quality.caseId}`,
    stage: "triage",
    status: input.triageAgentId ? "recorded" : "recorded",
    at,
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
    actionId: `repro:${input.quality.caseId}:${input.repro}`,
    stage: "repro",
    status: input.repro,
    at,
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
      at,
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
  return assembleAudit({
    number: current.number,
    title: current.title,
    body: current.body,
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
}): QualityAudit {
  const quality = parseCase(input.body);
  const recorded = input.comments
    .map((comment) => parseAudit(comment.body))
    .filter((event): event is QualityEvent => Boolean(event))
    .sort((a, b) => a.at.localeCompare(b.at));
  const stages = mergeStages(input, recorded);
  const hasLaunch = stages.some((stage) => stage.stage === "fix_launch");
  const engAck = stages.some((stage) => stage.stage === "engineering_ack" && stage.status === "acknowledged");
  const pr = latestPr(stages);
  const verAck = stages.some((stage) => stage.stage === "verification" && stage.status === "acknowledged");
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
      blocker: "adoption not acknowledged; do not launch another fix",
    });
  }
  if (pr && !verAck) {
    unresolved.push({
      stage: "verification",
      owner: "verification",
      blocker: "independent verification not acknowledged; pull request test report is not verification",
    });
  }
  if (pr && verAck && !merged && input.state === "open") {
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
      engineeringAdoption: engAck ? "acknowledged" : hasLaunch ? "unacknowledged" : "not_applicable",
      verification: verAck
        ? (pr ? "acknowledged" : "acknowledged_before_pull_request")
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
  };
}

function view(input: Omit<StageView, "source" | "actionId" | "pr" | "agentId" | "runId" | "error" | "attempt" | "severity" | "reason" | "category"> & {
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
  };
}

export async function acknowledgeStage(
  issue: number,
  stage: "engineering" | "verification",
): Promise<{ status: "acknowledged" | "already-acknowledged"; audit: QualityAudit }> {
  const current = await gh.getIssue(issue);
  const quality = parseCase(current.body);
  const comments = await gh.listComments(issue);
  const recordedPr = comments
    .map((comment) => parseFixResult(comment.body)?.prNumber)
    .find((number): number is number => typeof number === "number");
  const stageName = stage === "engineering" ? "engineering_ack" : "verification";
  const wrote = await recordQualityEvent(issue, buildEvent({
    actionId: `${stageName}:${issue}`,
    caseId: quality?.caseId ?? null,
    correlationId: quality?.correlationId ?? null,
    stage: stageName,
    status: "acknowledged",
    at: new Date().toISOString(),
    actor: "signed-link",
    issue,
    pr: recordedPr ?? null,
    agentId: null,
    runId: null,
    severity: quality?.severity ?? null,
    reason: quality?.reason ?? null,
    category: quality?.category ?? null,
    evidence: stage === "engineering"
      ? "signed adoption link; does not launch an agent"
      : "signed verification link; pull request test report was not accepted as verification",
    attempt: 1,
    nextOwner: stage === "engineering" ? (recordedPr ? "verification" : "app") : "human",
    blocker: stage === "verification"
      ? (recordedPr ? "signed merge not completed" : "acknowledged before a pull request was recorded")
      : "acknowledgement does not launch an agent",
    externalAck: "acknowledged",
  }));
  if (wrote === "failed") throw new Error("audit write failed");
  return {
    status: wrote === "recorded" ? "acknowledged" : "already-acknowledged",
    audit: await loadQualityAudit(issue),
  };
}
