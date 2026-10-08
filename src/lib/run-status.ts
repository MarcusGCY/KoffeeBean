import { Agent, type Run, type RunError, type RunResult } from "@cursor/sdk";

/**
 * Cloud runs launched from Next.js after() can make wait() lie or hang.
 * A stream 4xx right after create comes back as status "error" while the
 * agent keeps working, and a dropped connection can leave wait() pending.
 * Trust wait() only when it returns "finished". Otherwise poll Agent.getRun
 * until the run is terminal.
 */
export const WAIT_TIMEOUT_MS = 2 * 60 * 1000;
export const POLL_INTERVAL_MS = 15 * 1000;
export const POLL_CAP_MS = 30 * 60 * 1000;

/**
 * One in-process slice on Vercel. Hobby Fluid compute caps a function,
 * including `after()`, at 300s. A slice stops at 240s so launch, GitHub
 * writes, and the fix_completed POST still fit. Tracking then continues
 * from a later request. Local `npm run dev` does not use this cap.
 */
export const SERVERLESS_TRACK_BUDGET_MS = 240_000;

export function serverlessTrackBudgetMs(): number {
  return SERVERLESS_TRACK_BUDGET_MS;
}

const POLL_TIMEOUT_CODE = "status_poll_timeout";

export async function reconcileRunResult(run: Run, apiKey: string): Promise<RunResult> {
  const waited = await waitForRun(run);
  if (waited.kind === "result" && waited.result.status === "finished") {
    return waited.result;
  }

  const why =
    waited.kind === "timeout"
      ? "timed out"
      : waited.kind === "throw"
        ? `threw ${clip(redactSecrets(errorText(waited.error)), 300)}`
        : `returned status ${waited.result.status}`;
  console.warn(`[cursor] wait() ${why} for agent=${run.agentId} run=${run.id}; polling Agent.getRun`);
  return pollUntilTerminal(run, apiKey);
}

/** Human-readable failure text for a confirmed run error. Secrets are redacted. */
export function describeRunError(error: RunError | undefined): string | undefined {
  if (!error) return undefined;
  const message = redactSecrets(error.message).replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (!message && !error.code) return undefined;
  if (!message) return error.code;
  return error.code ? `${message} (${error.code})` : message;
}

type WaitOutcome =
  | { kind: "result"; result: RunResult }
  | { kind: "timeout" }
  | { kind: "throw"; error: unknown };

function waitForRun(run: Run): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, WAIT_TIMEOUT_MS);

    run.wait().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "result", result });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "throw", error });
      },
    );
  });
}

async function pollUntilTerminal(run: Run, apiKey: string): Promise<RunResult> {
  const deadline = Date.now() + POLL_CAP_MS;
  let last: Run | undefined;
  let lastFailure: string | undefined;

  for (;;) {
    try {
      const observed = await Agent.getRun(run.id, {
        runtime: "cloud",
        agentId: run.agentId,
        apiKey,
      });
      last = observed;
      lastFailure = undefined;
      console.log(`[cursor] Agent.getRun agent=${run.agentId} run=${run.id} status=${observed.status}`);
      const terminal = terminalResult(observed);
      if (terminal) return terminal;
    } catch (err) {
      lastFailure = errorText(err);
      console.error(`[cursor] Agent.getRun failed agent=${run.agentId} run=${run.id}`, err);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return timeoutResult(run, last, lastFailure);
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

function terminalResult(run: Run): RunResult | undefined {
  if (run.status === "running") return undefined;
  return {
    id: run.id,
    status: run.status,
    requestId: run.requestId,
    result: run.result,
    error: run.error,
    model: run.model,
    durationMs: run.durationMs,
    git: run.git,
    usage: run.usage,
  };
}

type RunSnapshot = {
  id?: string;
  requestId?: string;
  status?: Run["status"];
  result?: string;
  durationMs?: number;
  git?: Run["git"];
};

function timeoutResult(
  run: { id: string; requestId?: string },
  last: RunSnapshot | undefined,
  lastFailure: string | undefined,
): RunResult {
  const lastStatus = last?.status ?? "unavailable";
  const extra = lastFailure ? ` Last lookup error: ${clip(redactSecrets(lastFailure), 180)}.` : "";
  return {
    id: last?.id ?? run.id,
    requestId: last?.requestId ?? run.requestId,
    status: "error",
    result: last?.result,
    durationMs: last?.durationMs,
    git: last?.git,
    error: {
      message: `Timed out after ${Math.round(POLL_CAP_MS / 60000)} minutes waiting for a terminal run status (last status: ${lastStatus}).${extra}`,
      code: POLL_TIMEOUT_CODE,
    },
  };
}

/** Same error `reconcileRunResult` reports when the 30 minute cap is hit. */
export function trackingTimedOutResult(
  run: { id: string; requestId?: string },
  last?: RunSnapshot,
  lastFailure?: string,
): RunResult {
  return timeoutResult(run, last, lastFailure);
}

export type FollowOutcome =
  | { done: true; result: RunResult }
  | { done: false; lastStatus?: string; lastFailure?: string; last?: Run };

/**
 * Poll `Agent.getRun` until the run is terminal or `budgetMs` elapses.
 * Does not call `run.wait()`: on Vercel a hung stream keeps the isolate
 * alive until the platform kills it, which drops the completion callback.
 */
export async function followRun(
  run: { id: string; agentId: string },
  apiKey: string,
  budgetMs: number,
): Promise<FollowOutcome> {
  const deadline = Date.now() + budgetMs;
  let last: Run | undefined;
  let lastFailure: string | undefined;

  for (;;) {
    if (Date.now() >= deadline) {
      return { done: false, lastStatus: last?.status, lastFailure, last };
    }
    try {
      const observed = await Agent.getRun(run.id, {
        runtime: "cloud",
        agentId: run.agentId,
        apiKey,
      });
      last = observed;
      lastFailure = undefined;
      console.log(`[cursor] Agent.getRun agent=${run.agentId} run=${run.id} status=${observed.status}`);
      const terminal = terminalResult(observed);
      if (terminal) return { done: true, result: terminal };
    } catch (err) {
      lastFailure = errorText(err);
      console.error(`[cursor] Agent.getRun failed agent=${run.agentId} run=${run.id}`, err);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { done: false, lastStatus: last?.status, lastFailure, last };
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSecrets(text: string): string {
  const secret = process.env.CURSOR_API_KEY;
  if (!secret || secret.length < 8 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}
