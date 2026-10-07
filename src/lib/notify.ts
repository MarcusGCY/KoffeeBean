import { reviewLinks } from "./approval";

/**
 * Human-in-the-loop hook. Posts a review request to the Grok bot's webhook.
 * The payload is deliberately generic; adapt it once the bot's API is known.
 * The bot replies by calling the approve/reject URL (a GET, signed per decision).
 */
export async function requestReview(issue: {
  number: number; title: string; url: string; summary: string;
}) {
  const links = reviewLinks(issue.number);
  const url = process.env.GROK_WEBHOOK_URL;
  const payload = {
    type: "review_request",
    issue: { number: issue.number, title: issue.title, url: issue.url },
    summary: issue.summary,
    actions: [
      { id: "approve", label: "Approve & fix", url: links.approve },
      { id: "reject", label: "Reject", url: links.reject },
    ],
  };
  if (!url) {
    console.log("[notify] GROK_WEBHOOK_URL not set; review page:", links.page);
    return { delivered: false, reviewPage: links.page };
  }
  // GROK_WEBHOOK_AUTH is the full Authorization header value from the routine
  // panel (for example "Bearer …"). Sent unchanged. Omitted when unset.
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = process.env.GROK_WEBHOOK_AUTH?.trim();
  if (auth) headers.authorization = auth;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Grok webhook failed: ${res.status}`);
  return { delivered: true, reviewPage: links.page };
}
