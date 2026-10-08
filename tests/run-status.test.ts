import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getRun = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { getRun },
}));

import type { Run } from "@cursor/sdk";
import {
  POLL_CAP_MS,
  POLL_INTERVAL_MS,
  WAIT_TIMEOUT_MS,
  followRun,
  reconcileRunResult,
} from "@/lib/run-status";

const API_KEY = "test-cursor-key-do-not-log";
const RUN = "run-11111111-1111-4111-8111-111111111111";
const AGENT = "bc-22222222-2222-4222-8222-222222222222";
const PR = "https://github.com/acme/beanbox/pull/15";

function runLike(wait: Run["wait"]): Run {
  return { id: RUN, agentId: AGENT, wait } as Run;
}

beforeEach(() => {
  getRun.mockReset();
  process.env.CURSOR_API_KEY = API_KEY;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcileRunResult", () => {
  it("trusts wait() when it returns finished and does not poll", async () => {
    const wait = vi.fn(async () => ({
      id: RUN,
      status: "finished" as const,
      result: "done",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    }));

    const result = await reconcileRunResult(runLike(wait), API_KEY);

    expect(result.status).toBe("finished");
    expect(result.git?.branches[0]?.prUrl).toBe(PR);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("replaces a premature wait() error with the terminal Agent.getRun result", async () => {
    const wait = vi.fn(async () => ({
      id: RUN,
      status: "error" as const,
      error: { message: "stream 404", code: "not_found" },
      durationMs: 4000,
    }));
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      result: "fixed",
      durationMs: 60000,
      requestId: "req-real",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    const result = await reconcileRunResult(runLike(wait), API_KEY);

    expect(result).toMatchObject({ status: "finished", result: "fixed", requestId: "req-real" });
    expect(result.git?.branches[0]?.prUrl).toBe(PR);
    expect(result.error).toBeUndefined();
    expect(getRun).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith(RUN, { runtime: "cloud", agentId: AGENT, apiKey: API_KEY });
  });

  it("polls when wait() throws and keeps the confirmed result", async () => {
    const wait = vi.fn(async () => {
      throw new Error("stream 409");
    });
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      result: "still going",
    });

    await expect(reconcileRunResult(runLike(wait), API_KEY)).resolves.toMatchObject({
      status: "finished",
      result: "still going",
    });
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("keeps a confirmed error, including message and code, instead of the premature one", async () => {
    const wait = vi.fn(async () => ({
      id: RUN,
      status: "error" as const,
      error: { message: "stream reset", code: "not_found" },
    }));
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "error",
      error: { message: "agent exploded", code: "internal" },
      durationMs: 50,
      requestId: "req-real",
    });

    const result = await reconcileRunResult(runLike(wait), API_KEY);

    expect(result.error).toEqual({ message: "agent exploded", code: "internal" });
    expect(result.requestId).toBe("req-real");
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("polls every 15s while the run is still running", async () => {
    vi.useFakeTimers();
    const wait = vi.fn(async () => ({ id: RUN, status: "error" as const }));
    getRun
      .mockResolvedValueOnce({ id: RUN, agentId: AGENT, status: "running" })
      .mockResolvedValueOnce({ id: RUN, agentId: AGENT, status: "running" })
      .mockResolvedValueOnce({
        id: RUN,
        agentId: AGENT,
        status: "finished",
        git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
      });

    const pending = reconcileRunResult(runLike(wait), API_KEY);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(getRun).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const result = await pending;

    expect(result.status).toBe("finished");
    expect(result.git?.branches[0]?.prUrl).toBe(PR);
    expect(getRun).toHaveBeenCalledTimes(3);
  });

  it("falls back to polling when wait() hangs past the timeout", async () => {
    vi.useFakeTimers();
    const wait = vi.fn(() => new Promise<never>(() => {}));
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    const pending = reconcileRunResult(runLike(wait), API_KEY);
    await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS - 1);
    expect(getRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.status).toBe("finished");
    expect(result.git?.branches[0]?.prUrl).toBe(PR);
    expect(getRun).toHaveBeenCalledWith(RUN, { runtime: "cloud", agentId: AGENT, apiKey: API_KEY });
  });

  it("retries a failed Agent.getRun lookup until the run is terminal", async () => {
    vi.useFakeTimers();
    const wait = vi.fn(async () => ({ id: RUN, status: "cancelled" as const }));
    getRun
      .mockRejectedValueOnce(new Error("temporary 404"))
      .mockResolvedValueOnce({ id: RUN, agentId: AGENT, status: "finished", result: "kept" });

    const pending = reconcileRunResult(runLike(wait), API_KEY);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await expect(pending).resolves.toMatchObject({ status: "finished", result: "kept" });
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it("stops after about 30 minutes and reports the timeout without dropping a known PR", async () => {
    vi.useFakeTimers();
    const wait = vi.fn(async () => ({ id: RUN, status: "error" as const }));
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "running",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    const pending = reconcileRunResult(runLike(wait), API_KEY);
    await vi.advanceTimersByTimeAsync(POLL_CAP_MS + POLL_INTERVAL_MS);
    const result = await Promise.race([pending, Promise.resolve("still-pending" as const)]);

    expect(result).not.toBe("still-pending");
    if (result === "still-pending") return;
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("status_poll_timeout");
    expect(result.error?.message).toContain("last status: running");
    expect(result.git?.branches[0]?.prUrl).toBe(PR);
    expect(getRun.mock.calls.length).toBeGreaterThan(10);
    expect(getRun.mock.calls.length).toBeLessThan(200);
  });
});

describe("followRun", () => {
  it("returns a finished getRun without waiting out the budget", async () => {
    getRun.mockResolvedValue({
      id: RUN,
      agentId: AGENT,
      status: "finished",
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", prUrl: PR }] },
    });

    const outcome = await followRun({ id: RUN, agentId: AGENT }, API_KEY, 5_000);

    expect(outcome).toMatchObject({ done: true });
    if (!outcome.done) return;
    expect(outcome.result.status).toBe("finished");
    expect(outcome.result.git?.branches[0]?.prUrl).toBe(PR);
    expect(getRun).toHaveBeenCalledOnce();
    expect(getRun).toHaveBeenCalledWith(RUN, { runtime: "cloud", agentId: AGENT, apiKey: API_KEY });
  });

  it("returns pending once the budget passes while the run is still running", async () => {
    vi.useFakeTimers();
    getRun.mockResolvedValue({ id: RUN, agentId: AGENT, status: "running" });

    const pending = followRun({ id: RUN, agentId: AGENT }, API_KEY, 1_000);
    await vi.advanceTimersByTimeAsync(1_000 + POLL_INTERVAL_MS);

    await expect(pending).resolves.toMatchObject({ done: false, lastStatus: "running" });
    expect(getRun).toHaveBeenCalled();
  });
});
