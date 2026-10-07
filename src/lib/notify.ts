import { reviewLinks } from "./approval";

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

/** Ping the bot when the Cursor run finishes, including the GitHub comment text. */
export async function notifyFixCompleted(event: GrokIssue & {
  status: string;
  prUrl?: string;
  summary: string;
}): Promise<void> {
  await postGrokQuietly({
    type: "fix_completed",
    issue: { number: event.number, title: event.title, url: event.url },
    status: event.status,
    ...(event.prUrl ? { prUrl: event.prUrl } : {}),
    summary: event.summary,
  });
}
