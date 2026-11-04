export const CHAT_UNAVAILABLE =
  "Support chat is unavailable. Please use the 'Report a problem' button at the bottom right.";

export const CHAT_DROPPED = "Connection dropped, tap to retry";

export const CHAT_TIMEOUT = "Support chat timed out. Please try again.";

/** Shown before the shopper has a reply. Hidden as soon as they type. */
export const EMPTY_CHIPS = ["Reorder my usual", "Something fruity", "Where's my order?"] as const;

export function sgd(cents: number): string {
  return `S$${(cents / 100).toFixed(2)}`;
}

/** Three follow-ups after a reply. The client does not invent these. */
export function followUps(kind: "products" | "order" | "chat"): [string, string, string] {
  if (kind === "products") return ["Which is the most floral?", "Something darker", "Where's my order?"];
  if (kind === "order") return ["Reorder my usual", "Something fruity", "What's in my cart?"];
  return [...EMPTY_CHIPS];
}

export function noticeFor(status: number, error: string | undefined): string {
  if (status === 504 && error) return error;
  if (status === 429 && error) return error;
  if (status === 503 || error === "unavailable" || status === 502 || status >= 500) return CHAT_UNAVAILABLE;
  if (error) return error;
  return CHAT_UNAVAILABLE;
}

export type SseEvent = { event: string; data: string };

/** Pull complete SSE blocks out of a byte buffer. Comments such as heartbeats are skipped. */
export function takeSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    let sawData = false;
    for (const line of part.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        sawData = true;
        data.push(line.slice(5).trimStart());
      }
    }
    if (sawData) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}
