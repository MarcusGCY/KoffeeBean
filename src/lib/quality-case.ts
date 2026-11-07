import { createHmac, randomBytes } from "node:crypto";
import { env } from "./env";
import { safeEqual } from "./github-signature";
import { appOrigin } from "./origin";
import { redactText } from "./triage-redact";

/** Signed adoption and verification links stay valid for 7 days. */
export const QUALITY_ACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CLOCK_SKEW_MS = 60 * 1000;

export const CASE_MARKER = "beanbox-case";
export const AUDIT_MARKER = "beanbox-audit";

export const SEVERITIES = ["S1", "S2", "S3", "S4"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const REASONS = ["s4", "duplicate", "bug", "regression", "classify_failed"] as const;
export type QualityReason = (typeof REASONS)[number];

export const ACK_STAGES = ["engineering", "verification"] as const;
export type AckStage = (typeof ACK_STAGES)[number];

export type NotifyDelivery = "delivered" | "skipped" | "failed";

export function asDelivery(value: unknown): NotifyDelivery {
  return value === "delivered" || value === "skipped" || value === "failed" ? value : "skipped";
}

export type QualityCase = {
  caseId: string;
  correlationId: string;
  severity: Severity | null;
  reason: QualityReason | null;
  category: string | null;
};

export type QualityEvent = {
  v: 1;
  actionId: string;
  caseId: string | null;
  correlationId: string | null;
  stage: string;
  status: string;
  at: string;
  actor: string;
  issue: number | null;
  pr: number | null;
  agentId: string | null;
  runId: string | null;
  severity: Severity | null;
  reason: QualityReason | null;
  category: string | null;
  evidence: string | null;
  error: string | null;
  attempt: number;
  nextOwner: string;
  blocker: string | null;
  externalAck: "none" | "delivered" | "acknowledged";
};

const CASE_ID = /^kb-[0-9a-f]{16}$/;
const ACTION_ID = /^[a-z0-9:_-]{1,80}$/;
const STAGE = /^[a-z0-9_]{1,40}$/;
const CATEGORY = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;

const SUB = /\b(?:auth0|google-oauth2|waad|samlp|oauth2|oidc|windowslive|github|apple)\|[\w.|-]+/gi;
const BEARER = /Bearer\s+\S+/gi;
const TOKEN = /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]+\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function newQualityCaseId(): string {
  return `kb-${randomBytes(8).toString("hex")}`;
}

export function cleanSeverity(value: unknown): Severity | null {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value) ? value as Severity : null;
}

export function cleanReason(value: unknown): QualityReason | null {
  return typeof value === "string" && (REASONS as readonly string[]).includes(value) ? value as QualityReason : null;
}

export function cleanCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CATEGORY.test(trimmed) ? trimmed : null;
}

export function qualityCase(input: {
  caseId: string;
  severity?: unknown;
  reason?: unknown;
  category?: unknown;
}): QualityCase | undefined {
  if (!CASE_ID.test(input.caseId)) return undefined;
  return {
    caseId: input.caseId,
    correlationId: input.caseId,
    severity: cleanSeverity(input.severity),
    reason: cleanReason(input.reason),
    category: cleanCategory(input.category),
  };
}

/** Stable first line for every room message. Category and reason are tokens, not report text. */
export function severityLine(input: {
  severity?: string | null;
  category?: string | null;
  reason?: string | null;
}): string {
  const severity = cleanSeverity(input.severity) ?? "unknown";
  const category = cleanCategory(input.category) ?? "unspecified";
  const reason = cleanReason(input.reason) ?? "unspecified";
  return `Severity ${severity} · ${category} · ${reason}`;
}

export function reviewRequestMessage(input: {
  number: number;
  title: string;
  summary: string;
  severity?: string | null;
  category?: string | null;
  reason?: string | null;
}): string {
  return [
    severityLine(input),
    `Issue #${input.number}: ${oneLine(input.title)}`,
    oneLine(input.summary),
    "",
    "The app has not launched a fix. Approve or reject only with the signed links.",
    "Do not ask Triage or Engineering to start work.",
  ].join("\n");
}

export function fixStartedMessage(input: {
  number: number;
  title: string;
  agentId?: string | null;
  runId?: string | null;
  severity?: string | null;
  category?: string | null;
  reason?: string | null;
}): string {
  return [
    severityLine(input),
    `Issue #${input.number}: ${oneLine(input.title)}`,
    `The app launched the only fix. Agent ${tokenId(input.agentId)}, run ${tokenId(input.runId)}.`,
    "Do not launch another agent and do not ask Triage or Engineering to start a second fix.",
    "Opening the adoption link records acknowledgement only. It does not launch work.",
    "Next owner: engineering. Blocker: adoption not acknowledged.",
  ].join("\n");
}

export function fixCompletedMessage(input: {
  number: number;
  title: string;
  status: string;
  prUrl?: string;
  mergeUrl?: string;
  severity?: string | null;
  category?: string | null;
  reason?: string | null;
}): string {
  return [
    severityLine(input),
    `Issue #${input.number}: ${oneLine(input.title)}`,
    input.prUrl ? `Pull request: ${input.prUrl}` : "No pull request was opened.",
    `Run status: ${oneLine(input.status)}.`,
    "The pull request's own test report is not verification.",
    "Next owner: verification. Blocker: independent verification not acknowledged.",
    "The verification link records an acknowledgement only. It does not merge and does not launch an agent.",
    "The adoption link, if still open, also only records acknowledgement.",
    input.mergeUrl ? "Merge remains the separate signed merge link." : "No signed merge link is available.",
  ].join("\n");
}

export function fixMergedMessage(input: {
  number: number;
  prNumber: number;
  severity?: string | null;
  category?: string | null;
  reason?: string | null;
}): string {
  return [
    severityLine(input),
    `Squash-merged pull request #${input.prNumber} for issue #${input.number}.`,
    "Next owner: deploy. Blocker: deploy not observed by this app.",
  ].join("\n");
}

export function intakeMessage(input: {
  action: string;
  reason?: string | null;
  summary?: string | null;
  severity?: string | null;
  category?: string | null;
}): string {
  return [
    severityLine(input),
    `Intake ${oneLine(input.action)} · ${cleanReason(input.reason) ?? "unspecified"}.`,
    input.summary ? oneLine(input.summary) : "",
    "No fix is launched from this message. Do not ask Triage or Engineering to start work.",
  ].filter((line) => line !== "").join("\n");
}

export function caseMarker(quality: QualityCase): string {
  const payload = JSON.stringify(quality);
  return `<!-- ${CASE_MARKER} ${payload} ${sign(payload)} -->`;
}

export function appendCaseMarker(body: string, quality: QualityCase | undefined): string {
  if (!quality) return body;
  try {
    const marker = caseMarker(quality);
    if (body.includes(marker)) return body;
    return `${body}\n\n${marker}`;
  } catch {
    return body;
  }
}

export function parseCase(body: string): QualityCase | undefined {
  const re = /<!--\s*beanbox-case\s+(\{[\s\S]*?\})\s+([0-9a-f]{64})\s*-->/gi;
  for (const match of body.matchAll(re)) {
    const payload = match[1];
    const sig = match[2];
    if (!payload || !sig || !hmacEquals(sig, payload)) continue;
    try {
      const parsed = JSON.parse(payload) as { caseId?: unknown; severity?: unknown; reason?: unknown; category?: unknown };
      if (typeof parsed.caseId !== "string") continue;
      const quality = qualityCase({
        caseId: parsed.caseId,
        severity: parsed.severity,
        reason: parsed.reason,
        category: parsed.category,
      });
      if (quality) return quality;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function sealEvent(event: QualityEvent): string {
  const payload = JSON.stringify(event);
  const line = redactAudit([
    `Quality ${event.stage} ${event.status}.`,
    severityLine(event),
    `Next owner: ${event.nextOwner}.`,
    event.blocker ? `Blocker: ${event.blocker}.` : "Blocker: none.",
  ].join(" "));
  return `${line}\n\n<!-- ${AUDIT_MARKER} ${payload} ${sign(payload)} -->`;
}

export function parseAudit(body: string): QualityEvent | undefined {
  const re = /<!--\s*beanbox-audit\s+(\{[\s\S]*?\})\s+([0-9a-f]{64})\s*-->/gi;
  for (const match of body.matchAll(re)) {
    const payload = match[1];
    const sig = match[2];
    if (!payload || !sig || !hmacEquals(sig, payload)) continue;
    const event = readEvent(payload);
    if (event) return event;
  }
  return undefined;
}

export function buildEvent(input: Omit<QualityEvent, "v" | "evidence" | "error"> & {
  evidence?: string | null;
  error?: string | null;
}): QualityEvent {
  return {
    v: 1,
    actionId: input.actionId,
    caseId: input.caseId,
    correlationId: input.correlationId,
    stage: input.stage,
    status: input.status,
    at: input.at,
    actor: input.actor,
    issue: input.issue,
    pr: input.pr,
    agentId: input.agentId,
    runId: input.runId,
    severity: input.severity,
    reason: input.reason,
    category: input.category,
    evidence: input.evidence ? clip(redactAudit(input.evidence)) : null,
    error: input.error ? clip(redactAudit(input.error)) : null,
    attempt: input.attempt,
    nextOwner: input.nextOwner,
    blocker: input.blocker ? clip(redactAudit(input.blocker)) : null,
    externalAck: input.externalAck,
  };
}

export function redactAudit(value: string): string {
  const scrubbed = redactText(value).text
    .replace(BEARER, "Bearer [redacted]")
    .replace(TOKEN, "[redacted]")
    .replace(JWT, "[redacted]")
    .replace(SUB, "[redacted-sub]");
  return scrubSecrets(scrubbed);
}

export function qualityAckToken(issue: number, stage: AckStage, now = Date.now()): string {
  const exp = now + QUALITY_ACK_TTL_MS;
  return `${exp}.${sign(`ack:${issue}:${stage}:${exp}`)}`;
}

export function verifyQualityAck(
  issue: number,
  stage: string,
  token: string,
  now = Date.now(),
): "ok" | "expired" | "invalid" {
  if (!isAckStage(stage)) return "invalid";
  const grant = readGrant(token);
  if (!grant) return "invalid";
  if (!safeEqual(grant.sig, sign(`ack:${issue}:${stage}:${grant.exp}`))) return "invalid";
  if (grant.exp > now + QUALITY_ACK_TTL_MS + CLOCK_SKEW_MS) return "invalid";
  if (grant.exp <= now) return "expired";
  return "ok";
}

export function qualityAckLink(issue: number, stage: AckStage, now = Date.now()): string {
  const token = qualityAckToken(issue, stage, now);
  return `${appOrigin()}/api/quality/ack?issue=${issue}&stage=${stage}&token=${token}`;
}

export function isAckStage(value: string): value is AckStage {
  return (ACK_STAGES as readonly string[]).includes(value);
}

export function deliveryAck(delivery: NotifyDelivery): QualityEvent["externalAck"] {
  return delivery === "delivered" ? "delivered" : "none";
}

function oneLine(value: string): string {
  return redactAudit(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function tokenId(value: string | null | undefined): string {
  if (!value) return "unknown";
  const clean = value.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(clean)) return "unknown";
  return clean;
}

function clip(value: string): string {
  return value.length <= 300 ? value : `${value.slice(0, 300)}...`;
}

function sign(payload: string): string {
  return createHmac("sha256", env("APPROVAL_SECRET")).update(payload).digest("hex");
}

function hmacEquals(sig: string, payload: string): boolean {
  try {
    return safeEqual(sig, sign(payload));
  } catch {
    return false;
  }
}

function readGrant(token: string): { exp: number; sig: string } | undefined {
  const trimmed = token.trim();
  if (trimmed.length > 200) return undefined;
  const dot = trimmed.indexOf(".");
  if (dot <= 0) return undefined;
  const exp = Number(trimmed.slice(0, dot));
  const sig = trimmed.slice(dot + 1);
  if (!Number.isInteger(exp) || exp <= 0) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(sig)) return undefined;
  return { exp, sig };
}

function readEvent(payload: string): QualityEvent | undefined {
  try {
    const parsed = JSON.parse(payload) as Partial<QualityEvent>;
    if (parsed.v !== 1) return undefined;
    if (typeof parsed.actionId !== "string" || !ACTION_ID.test(parsed.actionId)) return undefined;
    if (typeof parsed.stage !== "string" || !STAGE.test(parsed.stage)) return undefined;
    if (typeof parsed.status !== "string" || !STAGE.test(parsed.status)) return undefined;
    if (typeof parsed.at !== "string") return undefined;
    if (typeof parsed.actor !== "string") return undefined;
    if (typeof parsed.nextOwner !== "string" || !parsed.nextOwner) return undefined;
    const caseId = typeof parsed.caseId === "string" && CASE_ID.test(parsed.caseId) ? parsed.caseId : null;
    const externalAck = parsed.externalAck === "delivered" || parsed.externalAck === "acknowledged"
      ? parsed.externalAck
      : "none";
    return buildEvent({
      actionId: parsed.actionId,
      caseId,
      correlationId: caseId,
      stage: parsed.stage,
      status: parsed.status,
      at: parsed.at,
      actor: clip(redactAudit(parsed.actor)),
      issue: positiveInt(parsed.issue),
      pr: positiveInt(parsed.pr),
      agentId: idOrNull(parsed.agentId),
      runId: idOrNull(parsed.runId),
      severity: cleanSeverity(parsed.severity),
      reason: cleanReason(parsed.reason),
      category: cleanCategory(parsed.category),
      evidence: typeof parsed.evidence === "string" ? parsed.evidence : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      attempt: typeof parsed.attempt === "number" && parsed.attempt > 0 ? Math.floor(parsed.attempt) : 1,
      nextOwner: clip(redactAudit(parsed.nextOwner)),
      blocker: typeof parsed.blocker === "string" ? parsed.blocker : null,
      externalAck,
    });
  } catch {
    return undefined;
  }
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function idOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(clean) ? clean : null;
}

function scrubSecrets(text: string): string {
  const names = ["CURSOR_API_KEY", "GITHUB_TOKEN", "APPROVAL_SECRET", "GROK_WEBHOOK_AUTH", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "CRON_SECRET", "BI_API_SECRET", "BI_HASH_SECRET", "DATABASE_URL"];
  let out = text;
  for (const name of names) {
    const secret = process.env[name];
    if (!secret || secret.length < 8 || !out.includes(secret)) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
