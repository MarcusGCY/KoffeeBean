import { confirmedCard } from "./pending-action";
import { signSupportToken } from "./support-token";

const UNAVAILABLE = "Support chat is unavailable";

export type AgentTurn = {
  userId: string;
  message: string;
  sessionId?: string;
  continuationToken?: string;
};

export type PendingAction = { actionId: string; summary: string };

export type AgentReply = {
  reply: string;
  sessionId: string;
  continuationToken: string;
  pendingAction?: PendingAction;
};

type AgentEvent = {
  type?: string;
  turnId?: string;
  data?: {
    text?: unknown;
    finishReason?: unknown;
    result?: unknown;
    parentCallId?: unknown;
    output?: unknown;
    results?: { output?: unknown }[];
  };
};

function agentBase(): string {
  return (process.env.SUPPORT_AGENT_URL ?? "").trim().replace(/\/$/, "");
}

export function supportConfigured(): boolean {
  return Boolean(agentBase() && process.env.SUPPORT_AGENT_SECRET?.trim());
}

function headers(userId: string): Headers {
  const secret = process.env.SUPPORT_AGENT_SECRET?.trim() ?? "";
  const headers = new Headers({
    authorization: `Bearer ${signSupportToken(userId, secret)}`,
    accept: "application/json",
  });
  const alias = process.env.SUPPORT_AGENT_ALIAS_TOKEN?.trim();
  if (alias) headers.set("X-Agent-Alias-Token", alias);
  return headers;
}

async function postJson(url: string, userId: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const initHeaders = headers(userId);
  initHeaders.set("content-type", "application/json");
  return fetch(url, { method: "POST", headers: initHeaders, body: JSON.stringify(body), signal });
}

function actionIdFrom(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const row = output as { pending?: unknown; actionId?: unknown };
  if (row.pending !== true || typeof row.actionId !== "string" || !row.actionId) return undefined;
  return row.actionId;
}

/** Turn id of the reply we are about to show. Older turns are ignored. */
function replyTurnId(events: AgentEvent[]): string | undefined {
  let turnId: string | undefined;
  for (const event of events) {
    const data = event.data ?? {};
    if (
      event.type === "message.completed" &&
      data.finishReason === "stop" &&
      data.parentCallId == null &&
      typeof data.text === "string" &&
      data.text.trim() &&
      event.turnId
    ) {
      turnId = event.turnId;
    }
  }
  return turnId;
}

/**
 * Last confirm action from this turn only. The summary is the signed one,
 * not text the agent attached to the tool result.
 */
export function pendingFromEvents(events: AgentEvent[], userId: string, rawSecret: string): PendingAction | undefined {
  const turnId = replyTurnId(events);
  if (!turnId) return undefined;
  let actionId: string | undefined;
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    const data = event.data ?? {};
    if (event.type === "action.result") {
      const id = actionIdFrom(data.output);
      if (id) actionId = id;
    }
    if (event.type === "actions.completed" && Array.isArray(data.results)) {
      for (const result of data.results) {
        const id = actionIdFrom(result?.output);
        if (id) actionId = id;
      }
    }
  }
  if (!actionId) return undefined;
  return confirmedCard(userId, actionId, rawSecret);
}

function replyFrom(events: AgentEvent[]): string | null | undefined {
  let reply = "";
  let finished = false;
  for (const event of events) {
    const data = event.data ?? {};
    if (
      event.type === "message.completed" &&
      data.finishReason === "stop" &&
      data.parentCallId == null &&
      typeof data.text === "string" &&
      data.text.trim()
    ) {
      reply = data.text.trim();
    }
    if (event.type === "turn.failed" || event.type === "session.failed") return null;
    if (event.type === "turn.completed") {
      finished = true;
      if (!reply && typeof data.result === "string" && data.result.trim()) reply = data.result.trim();
    }
  }
  if (!finished) return undefined;
  return reply || null;
}

async function waitForReply(
  sessionId: string,
  userId: string,
  signal: AbortSignal,
): Promise<{ reply: string; pendingAction?: PendingAction }> {
  const url = `${agentBase()}/v1/session/${encodeURIComponent(sessionId)}/events?format=json`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("aborted");
    const response = await fetch(url, { headers: headers(userId), signal });
    if (response.ok) {
      const body = (await response.json()) as { events?: AgentEvent[] };
      const events = Array.isArray(body.events) ? body.events : [];
      const reply = replyFrom(events);
      if (reply) {
        const rawSecret = process.env.SUPPORT_AGENT_SECRET?.trim() ?? "";
        return { reply, pendingAction: pendingFromEvents(events, userId, rawSecret) };
      }
      if (reply === null) throw new Error("no_reply");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timeout");
}

async function openSession(
  userId: string,
  message: string,
  signal: AbortSignal,
  prior?: { sessionId: string; continuationToken: string },
): Promise<{ sessionId: string; continuationToken: string }> {
  const base = agentBase();
  if (prior) {
    const follow = await postJson(
      `${base}/v1/session/${encodeURIComponent(prior.sessionId)}`,
      userId,
      { continuationToken: prior.continuationToken, message },
      signal,
    );
    if (follow.status !== 409) {
      if (!follow.ok) throw new Error(`status_${follow.status}`);
      const body = (await follow.json()) as { sessionId?: unknown; continuationToken?: unknown };
      if (typeof body.sessionId !== "string" || typeof body.continuationToken !== "string") {
        throw new Error("missing_session");
      }
      return { sessionId: body.sessionId, continuationToken: body.continuationToken };
    }
  }
  const started = await postJson(`${base}/v1/session`, userId, { message }, signal);
  if (!started.ok) throw new Error(`status_${started.status}`);
  const body = (await started.json()) as { sessionId?: unknown; continuationToken?: unknown };
  if (typeof body.sessionId !== "string" || typeof body.continuationToken !== "string") {
    throw new Error("missing_session");
  }
  return { sessionId: body.sessionId, continuationToken: body.continuationToken };
}

export async function askSupportAgent(turn: AgentTurn): Promise<AgentReply> {
  if (!supportConfigured()) throw new Error("unconfigured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const prior =
      turn.sessionId && turn.continuationToken
        ? { sessionId: turn.sessionId, continuationToken: turn.continuationToken }
        : undefined;
    const session = await openSession(turn.userId, turn.message, controller.signal, prior);
    const done = await waitForReply(session.sessionId, turn.userId, controller.signal);
    return {
      reply: done.reply,
      sessionId: session.sessionId,
      continuationToken: session.continuationToken,
      pendingAction: done.pendingAction,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function chatFailureStatus(err: unknown): { status: number; error: string } {
  const name = err instanceof Error ? err.name : "Error";
  console.error("[chat] request failed", name);
  return { status: 502, error: UNAVAILABLE };
}
