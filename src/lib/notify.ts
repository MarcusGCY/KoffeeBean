import { reviewLinks } from "./approval";
import { mergeLink, prNumberFromUrl } from "./merge-link";

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
async function postGrokQuietly(payload: { type: string; [key: string]: unknown }): Promise<void> {
  const url = process.env.GROK_WEBHOOK_URL;
  if (!url) {
    console.log(`[notify] GROK_WEBHOOK_URL not set; skipped ${payload.type}`);
    return;
  }
  try {
    await postGrok(payload);
  } catch (e) {
    console.error(`[notify] ${payload.type} failed`, e);
  }
}

/**
 * Human-in-the-loop hook. Posts a review request to the Grok bot's webhook.
 * The payload is deliberately generic; adapt it once the bot's API is known.
 * The bot replies by calling the approve/reject URL (a GET, signed per decision).
 */
export async function requestReview(issue: GrokIssue & { summary: string }) {
  const links = reviewLinks(issue.number);
  const payload = {
    type: "review_request",
    issue: { number: issue.number, title: issue.title, url: issue.url },
    summary: issue.summary,
    actions: [
      { id: "approve", label: "Approve & fix", url: links.approve },
      { id: "reject", label: "Reject", url: links.reject },
    ],
  };
  if (!process.env.GROK_WEBHOOK_URL) {
    console.log("[notify] GROK_WEBHOOK_URL not set; review page:", links.page);
    return { delivered: false, reviewPage: links.page };
  }
  const delivered = await postGrok(payload);
  return { delivered, reviewPage: links.page };
}

/** Ping the bot when Approve kicks off a Cursor fix. */
export async function notifyFixStarted(issue: GrokIssue): Promise<void> {
  await postGrokQuietly({
    type: "fix_started",
    issue: { number: issue.number, title: issue.title, url: issue.url },
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
}): Promise<void> {
  const pull = completedPull(event.number, event.prUrl);
  await postGrokQuietly({
    type: "fix_completed",
    issue: { number: event.number, title: event.title, url: event.url },
    status: event.status,
    ...(event.prUrl ? { prUrl: event.prUrl } : {}),
    ...pull,
    summary: event.summary,
  });
}

/** Ping the bot after the signed link squash-merges the fix. */
export async function notifyFixMerged(event: GrokIssue & {
  prNumber: number;
  prUrl: string;
  sha: string;
}): Promise<void> {
  await postGrokQuietly({
    type: "fix_merged",
    issue: { number: event.number, title: event.title, url: event.url },
    prNumber: event.prNumber,
    prUrl: event.prUrl,
    sha: event.sha,
    summary: `Squash-merged pull request #${event.prNumber}. Vercel will redeploy main shortly.`,
  });
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
