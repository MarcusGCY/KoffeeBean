import { spawn } from "node:child_process";
import { serve } from "@grok/agent-sdk";
import os from "node:os";
import path from "node:path";
import { confirmedCard } from "./pending-action";
import { signSupportToken } from "./support-token";

const UNAVAILABLE = "Support chat is unavailable";

/** Stay under the Vercel 300s function limit. */
export const SUPPORT_RUN_MS = 270_000;

export class SupportTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "SupportTimeoutError";
  }
}

let agentUrl: Promise<string> | undefined;

function approvalSecret(): string {
  return process.env.APPROVAL_SECRET?.trim() ?? "";
}

function supportServeOptions() {
  return {
    host: "127.0.0.1",
    port: 0,
    playground: false,
    docs: false,
    schedules: false,
    reminders: false,
    apiKey: process.env.CURSOR_API_KEY,
    stateRoot: path.join(os.tmpdir(), "beanbox-support"),
    mode: "single" as const,
  };
}

/**
 * Vitest mocks `serve()`. Production runs it in a child process: Next's
 * module hooks load the agent's TypeScript but drop `defineAgent` /
 * `defineTool`, and `serve()` then refuses to start. `node --import tsx`
 * outside those hooks loads the files. HOME is /tmp so the harness does not
 * write `~/.cache` or `~/.cursor` on a read-only serverless filesystem.
 */
function localAgentUrl(): Promise<string> {
  if (!agentUrl) {
    const started = process.env.VITEST ? startInProcess() : startChild();
    agentUrl = started.catch((err) => {
      agentUrl = undefined;
      throw err;
    });
  }
  return agentUrl;
}

function startInProcess(): Promise<string> {
  return serve(path.join(process.cwd(), "support-agent"), supportServeOptions()).then((handle) =>
    (handle.agents[0]?.url ?? handle.url).replace(/\/$/, ""),
  );
}

function startChild(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(process.cwd(), "scripts/support-serve.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: os.tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => fail(new Error("support_agent_start_timeout")), 20_000);
    const ok = (url: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(err);
    };
    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
      const line = stdout.split("\n").find((row) => row.startsWith("SUPPORT_URL="));
      if (line) ok(line.slice("SUPPORT_URL=".length).trim());
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString()).slice(-2000);
    });
    child.on("error", fail);
    child.on("exit", (code) => {
      agentUrl = undefined;
      const detail = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("Refusing to serve") || line.startsWith("error:") || line.startsWith("Error:"))
        .join(" ")
        .slice(0, 500);
      fail(new Error(detail || `support_agent_exit_${code ?? "unknown"}`));
    });
  });
}

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

export function supportConfigured(): boolean {
  return Boolean(process.env.CURSOR_API_KEY?.trim() && approvalSecret());
}

function headers(userId: string): Headers {
  return new Headers({
    authorization: `Bearer ${signSupportToken(userId, approvalSecret())}`,
    accept: "application/json",
  });
}

function timedOut(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === "AbortError") || err instanceof SupportTimeoutError;
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
    if (event.type === "turn.failed" || event.type === "session.failed") {
      console.error("[chat] agent event", event.type, publicEventData(data));
      return null;
    }
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
  const url = `${await localAgentUrl()}/v1/session/${encodeURIComponent(sessionId)}/events?format=json`;
  const deadline = Date.now() + SUPPORT_RUN_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new SupportTimeoutError();
    const response = await fetch(url, { headers: headers(userId), signal });
    if (response.ok) {
      const body = (await response.json()) as { events?: AgentEvent[] };
      const events = Array.isArray(body.events) ? body.events : [];
      const reply = replyFrom(events);
      if (reply) {
        return { reply, pendingAction: pendingFromEvents(events, userId, approvalSecret()) };
      }
      if (reply === null) throw new Error("no_reply");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SupportTimeoutError();
}

const SESSION_ID_HEADER = "x-agent-serve-session-id";

async function readOpenedSession(
  response: Response,
  note: (sessionId: string) => void,
): Promise<{ sessionId: string; continuationToken: string }> {
  const headerId = response.headers.get(SESSION_ID_HEADER)?.trim();
  if (headerId) note(headerId);
  const body = (await response.json()) as { sessionId?: unknown; continuationToken?: unknown };
  const sessionId = (typeof body.sessionId === "string" && body.sessionId.trim()) || headerId;
  if (!sessionId || typeof body.continuationToken !== "string") throw new Error("missing_session");
  note(sessionId);
  return { sessionId, continuationToken: body.continuationToken };
}

async function openSession(
  userId: string,
  message: string,
  signal: AbortSignal,
  note: (sessionId: string) => void,
  prior?: { sessionId: string; continuationToken: string },
): Promise<{ sessionId: string; continuationToken: string }> {
  const base = await localAgentUrl();
  if (prior) {
    const follow = await postJson(
      `${base}/v1/session/${encodeURIComponent(prior.sessionId)}`,
      userId,
      { continuationToken: prior.continuationToken, message },
      signal,
    );
    if (follow.status !== 409) {
      if (!follow.ok) throw new Error(`status_${follow.status}`);
      return readOpenedSession(follow, note);
    }
  }
  const started = await postJson(`${base}/v1/session`, userId, { message }, signal);
  if (!started.ok) throw new Error(`status_${started.status}`);
  return readOpenedSession(started, note);
}

/** Stop the in-process run. The SDK maps this to run.cancel() so the turn stops billing. */
async function stopSession(sessionId: string, userId: string): Promise<void> {
  try {
    const base = await localAgentUrl();
    await fetch(`${base}/v1/session/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: headers(userId),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("[chat] stop failed", err instanceof Error ? err.name : "Error");
  }
}

export async function askSupportAgent(turn: AgentTurn, timeoutMs = SUPPORT_RUN_MS): Promise<AgentReply> {
  if (!supportConfigured()) throw new Error("unconfigured");
  const controller = new AbortController();
  let sessionId: string | undefined;
  let stopping: Promise<void> | undefined;
  const stopOnce = () => {
    if (!sessionId) return;
    if (!stopping) stopping = stopSession(sessionId, turn.userId);
    return stopping;
  };
  const note = (id: string) => {
    sessionId = id;
    if (controller.signal.aborted) void stopOnce();
  };
  const timer = setTimeout(() => {
    controller.abort();
    void stopOnce();
  }, timeoutMs);
  try {
    const prior =
      turn.sessionId && turn.continuationToken
        ? { sessionId: turn.sessionId, continuationToken: turn.continuationToken }
        : undefined;
    const session = await openSession(turn.userId, turn.message, controller.signal, note, prior);
    const done = await waitForReply(session.sessionId, turn.userId, controller.signal);
    return {
      reply: done.reply,
      sessionId: session.sessionId,
      continuationToken: session.continuationToken,
      pendingAction: done.pendingAction,
    };
  } catch (err) {
    if (timedOut(err, controller.signal)) {
      await stopOnce();
      throw new SupportTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Name, message, code, and a short cause chain. No tokens, headers, or env values. */
function publicError(err: unknown, depth = 0): { name: string; message: string; code?: string | number; cause?: unknown } {
  if (!(err instanceof Error) || depth > 2) {
    return { name: "Error", message: "non-error" };
  }
  const code = "code" in err && (typeof err.code === "string" || typeof err.code === "number") ? err.code : undefined;
  const cause = err.cause === undefined ? undefined : publicError(err.cause, depth + 1);
  return {
    name: err.name,
    message: err.message,
    ...(code === undefined ? {} : { code }),
    ...(cause === undefined ? {} : { cause }),
  };
}

function publicEventData(data: AgentEvent["data"]): Record<string, string | number> {
  const source = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const out: Record<string, string | number> = {};
  for (const key of ["status", "code", "message", "error", "finishReason"]) {
    const value = source[key];
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (typeof value === "number") out[key] = value;
  }
  return out;
}

export function chatFailureStatus(err: unknown): { status: number; error: string } {
  console.error("[chat] request failed", publicError(err));
  return { status: 502, error: UNAVAILABLE };
}
