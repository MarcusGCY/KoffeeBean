export const CHAT_UNAVAILABLE =
  "Support chat is unavailable. Please use the 'Report a problem' button at the bottom right.";

export const CHAT_DROPPED = "Connection dropped, tap to retry";

/**
 * What the support chat accepted from POST /api/chat after PR 45.
 * A 200 body with a non-empty `reply` is shown. Session fields are optional.
 */
export function acceptsDirectChatReply(status: number, body: { reply?: unknown } | null): boolean {
  return status === 200 && typeof body?.reply === "string" && body.reply.length > 0;
}

export function noticeFor(status: number, error: string | undefined): string {
  if (status === 504 && error) return error;
  if (status === 429 && error) return error;
  if (status === 503 || error === "unavailable" || status === 502 || status >= 500) return CHAT_UNAVAILABLE;
  if (error) return error;
  return CHAT_UNAVAILABLE;
}
