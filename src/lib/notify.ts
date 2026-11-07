import { reviewLinks } from "./approval";
import { mergeLink, prNumberFromUrl } from "./merge-link";
import {
  fixCompletedMessage,
  fixMergedMessage,
  fixStartedMessage,
  intakeMessage,
  qualityAckLink,
  qualityCase,
  reviewRequestMessage,
  severityLine,
  type NotifyDelivery,
  type QualityCase,
} from "./quality-case";

export type { NotifyDelivery };

export type GrokIssue = { number: number; title: string; url: string };

/**
 * GROK_WEBHOOK_AUTH may be "Bearer …" or the full "Authorization: Bearer …"
 * line copied from the routine panel. A leading "Authorization:" is stripped
 * so the header value is not doubled. Omitted when unset.
 */
function authorizationHeader(): string | undefined {
  let auth = process.env.GROK_WEBHOOK_AUTH?.trim();
  if (auth?.toLowerCase().startsWith("authorization:")) {
    auth = auth.slice("authorization:".length).trim();
  }
  return auth || undefined;
}

async function postGrok(payload: unknown): Promise<boolean> {
  const url = process.env.GROK_WEBHOOK_URL;
  if (!url) return false;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = authorizationHeader();
  if (auth) headers.authorization = auth;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Grok webhook failed: ${res.status}`);
  return true;
}

/** Log webhook failures. Fix progress must not abort the Cursor run. */
async function postGrokQuietly(payload: { type: string; [key: string]: unknown }): Promise<NotifyDelivery> {
  const url = process.env.GROK_WEBHOOK_URL;
  if (!url) {
    console.log(`[notify] GROK_WEBHOOK_URL not set; skipped ${payload.type}`);
    return "skipped";
  }
  try {
    await postGrok(payload);
    return "delivered";
  } catch (e) {
    console.error(`[notify] ${payload.type} failed`, e instanceof Error ? e.name : "Error");
    return "failed";
  }
}

/**
 * Human-in-the-loop hook. Posts a review request to the Grok bot's webhook.
 * The payload is deliberately generic; adapt it once the bot's API is known.
 * The bot replies by calling the approve/reject URL (a GET, signed per decision).
 */
export async function requestReview(issue: GrokIssue & { summary: string; quality?: QualityCase }) {
  const links = reviewLinks(issue.number);
  const payload = {
    type: "review_request",
    issue: { number: issue.number, title: issue.title, url: issue.url },
    summary: issue.summary,
    actions: [
      { id: "approve", label: "Approve & fix", url: links.approve },
      { id: "reject", label: "Reject", url: links.reject },
    ],
    ...(issue.quality ? {
      ...caseNotice(issue.quality),
      message: reviewRequestMessage({
        number: issue.number,
        title: issue.title,
        summary: issue.summary,
        ...issue.quality,
      }),
      nextOwner: "human",
      blocker: "waiting for signed approval",
    } : {}),
  };
  if (!process.env.GROK_WEBHOOK_URL) {
    console.log("[notify] GROK_WEBHOOK_URL not set; review page:", links.page);
    return { delivered: false, delivery: "skipped" as const, reviewPage: links.page };
  }
  const delivered = await postGrok(payload);
  return { delivered, delivery: "delivered" as const, reviewPage: links.page };
}

/** Ping the bot when Approve kicks off a Cursor fix. */
export async function notifyFixStarted(issue: GrokIssue & {
  quality?: QualityCase | null;
  agentId?: string;
  runId?: string;
}): Promise<NotifyDelivery> {
  const handoff = issue.quality !== undefined || issue.agentId !== undefined;
  return postGrokQuietly({
    type: "fix_started",
    issue: { number: issue.number, title: issue.title, url: issue.url },
    ...(handoff ? fixStartedFields(issue) : {}),
  });
}

/**
 * Ping the bot when the Cursor run finishes, including the GitHub comment text.
 * `prNumber` and `mergeUrl` are added only for a pull request in GITHUB_REPO.
 * Older clients can ignore those fields.
 */
export async function notifyFixCompleted(event: GrokIssue & {
  status: string;
  prUrl?: string;
  summary: string;
  quality?: QualityCase | null;
  agentId?: string;
  runId?: string;
}): Promise<NotifyDelivery> {
  const pull = completedPull(event.number, event.prUrl);
  const handoff = "quality" in event;
  return postGrokQuietly({
    type: "fix_completed",
    issue: { number: event.number, title: event.title, url: event.url },
    status: event.status,
    ...(event.prUrl ? { prUrl: event.prUrl } : {}),
    ...pull,
    summary: event.summary,
    ...(handoff ? fixCompletedFields(event, pull?.mergeUrl) : {}),
  });
}

/**
 * Lead signal for every classified report. No new issue number.
 * Nothing is emailed; this is the same webhook as the other bot pings.
 * `known_case_url` is set when `duplicate_of` is set, including a regression of a closed issue.
 */
export async function notifyIntakeClassification(event: {
  action: "hold" | "file";
  reason: "s4" | "duplicate" | "bug" | "regression" | "classify_failed";
  severity: string | null;
  duplicate_of: number | null;
  fallback: boolean;
  needs_human: boolean;
  category: string | null;
  summary: string | null;
  confidence: number | null;
  duplicate_confidence: number | null;
  suspected_area: string | null;
  redacted_text: string | null;
  reportedBy: string;
  known_case_url?: string;
  caseId?: string;
}): Promise<NotifyDelivery> {
  const quality = event.caseId
    ? qualityCase({
      caseId: event.caseId,
      severity: event.severity,
      reason: event.reason,
      category: event.category,
    })
    : undefined;
  return postGrokQuietly({
    type: "intake_classification",
    action: event.action,
    reason: event.reason,
    severity: event.severity,
    duplicate_of: event.duplicate_of,
    fallback: event.fallback,
    needs_human: event.needs_human,
    category: event.category,
    summary: event.summary,
    confidence: event.confidence,
    duplicate_confidence: event.duplicate_confidence,
    suspected_area: event.suspected_area,
    redacted_text: event.redacted_text,
    reportedBy: event.reportedBy,
    ...(event.known_case_url ? { known_case_url: event.known_case_url } : {}),
    ...(quality ? {
      caseId: quality.caseId,
      correlationId: quality.correlationId,
      severityLine: severityLine(quality),
      message: intakeMessage({
        action: event.action,
        reason: quality.reason,
        summary: event.summary,
        severity: quality.severity,
        category: quality.category,
      }),
    } : {}),
  });
}

/** Ping the bot after the signed link squash-merges the fix. */
export async function notifyFixMerged(event: GrokIssue & {
  prNumber: number;
  prUrl: string;
  sha: string;
  quality?: QualityCase | null;
}): Promise<NotifyDelivery> {
  const handoff = "quality" in event;
  return postGrokQuietly({
    type: "fix_merged",
    issue: { number: event.number, title: event.title, url: event.url },
    prNumber: event.prNumber,
    prUrl: event.prUrl,
    sha: event.sha,
    summary: `Squash-merged pull request #${event.prNumber}. Vercel will redeploy main shortly.`,
    ...(handoff ? {
      ...caseNotice(event.quality),
      message: fixMergedMessage({
        number: event.number,
        prNumber: event.prNumber,
        severity: event.quality?.severity,
        category: event.quality?.category,
        reason: event.quality?.reason,
      }),
      nextOwner: "deploy",
      blocker: "deploy not observed by this app",
    } : {}),
  });
}

function caseNotice(quality: QualityCase | null | undefined) {
  return {
    caseId: quality?.caseId ?? null,
    correlationId: quality?.correlationId ?? null,
    severity: quality?.severity ?? null,
    reason: quality?.reason ?? null,
    category: quality?.category ?? null,
    severityLine: severityLine(quality ?? {}),
  };
}

function fixStartedFields(issue: GrokIssue & { quality?: QualityCase | null; agentId?: string; runId?: string }) {
  let adoptionUrl: string | undefined;
  try {
    adoptionUrl = qualityAckLink(issue.number, "engineering");
  } catch (error) {
    console.error("[notify] could not sign adoption link", error instanceof Error ? error.name : "Error");
  }
  return {
    launched: true,
    doNotLaunch: true,
    agentId: issue.agentId ?? null,
    runId: issue.runId ?? null,
    ...caseNotice(issue.quality),
    message: fixStartedMessage({
      number: issue.number,
      title: issue.title,
      agentId: issue.agentId,
      runId: issue.runId,
      severity: issue.quality?.severity,
      category: issue.quality?.category,
      reason: issue.quality?.reason,
    }),
    nextOwner: "engineering",
    blocker: "adoption not acknowledged",
    ...(adoptionUrl ? { adoptionUrl } : {}),
  };
}

function fixCompletedFields(
  event: GrokIssue & { status: string; prUrl?: string; quality?: QualityCase | null; agentId?: string; runId?: string },
  mergeUrl: string | undefined,
) {
  let verificationUrl: string | undefined;
  let adoptionUrl: string | undefined;
  try {
    verificationUrl = qualityAckLink(event.number, "verification");
    adoptionUrl = qualityAckLink(event.number, "engineering");
  } catch (error) {
    console.error("[notify] could not sign verification link", error instanceof Error ? error.name : "Error");
  }
  return {
    doNotLaunch: true,
    selfReportedTestsAreVerification: false,
    agentId: event.agentId ?? null,
    runId: event.runId ?? null,
    ...caseNotice(event.quality),
    message: fixCompletedMessage({
      number: event.number,
      title: event.title,
      status: event.status,
      prUrl: event.prUrl,
      mergeUrl,
      severity: event.quality?.severity,
      category: event.quality?.category,
      reason: event.quality?.reason,
    }),
    nextOwner: "verification",
    blocker: "independent verification not acknowledged",
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(adoptionUrl ? { adoptionUrl } : {}),
  };
}

function completedPull(
  issueNumber: number,
  prUrl: string | undefined,
): { prNumber: number; mergeUrl?: string } | undefined {
  if (!prUrl) return undefined;
  const configured = process.env.GITHUB_REPO?.trim();
  if (!configured?.includes("/")) return undefined;
  const prNumber = prNumberFromUrl(prUrl, configured);
  if (!prNumber) return undefined;
  try {
    return { prNumber, mergeUrl: mergeLink(issueNumber, prNumber) };
  } catch (error) {
    console.error("[notify] could not sign merge link", error);
    return { prNumber };
  }
}
