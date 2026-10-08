import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create, getRun },
}));

import { triageFeedback } from "@/lib/triage";
import type { OpenIssue } from "@/lib/github";

const API_KEY = "test-cursor-key-do-not-log";
const AGENT = "bc-00000000-0000-4000-8000-000000000001";
const open: OpenIssue[] = [{ number: 7, title: "Coupon ignored", body: "SAVE10 does nothing when typed in lowercase." }];

type Status = "finished" | "error" | "cancelled";

function fakeAgent(result: {
  status: Status;
  result?: string;
  durationMs?: number;
  requestId?: string;
  id?: string;
  error?: { message: string; code?: string };
}) {
  const close = vi.fn();
  const runId = result.id ?? "run-id";
  const wait = vi.fn(async () => ({
    id: runId,
    requestId: result.requestId,
    durationMs: result.durationMs,
    status: result.status,
    result: result.result,
    error: result.error,
  }));
  const send = vi.fn(async (_prompt: string) => ({ id: runId, agentId: AGENT, wait }));
  return { close, send, agent: { agentId: AGENT, send, close } };
}

function confirmed(result: {
  status: Status;
  result?: string;
  durationMs?: number;
  requestId?: string;
  id?: string;
  error?: { message: string; code?: string };
}) {
  return {
    id: result.id ?? "run-id",
    agentId: AGENT,
    requestId: result.requestId,
    durationMs: result.durationMs,
    status: result.status,
    result: result.result,
    error: result.error,
  };
}

beforeEach(() => {
  create.mockReset();
  getRun.mockReset();
  process.env.CURSOR_API_KEY = API_KEY;
  process.env.GITHUB_REPO = "acme/beanbox";
  delete process.env.VERCEL;
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("triageFeedback", () => {
  it("keeps a finished plan when wait() reports a false error", async () => {
    const fenced = [
      "Different wording, same coupon bug.",
      "```json",
      '{"action":"merge","issueNumber":7,"title":"Coupon case","body":"Trim and lowercase codes."}',
      "```",
    ].join("\n");
    const attempt = fakeAgent({
      status: "error",
      durationMs: 4000,
      requestId: "req-stream",
      error: { message: "not found", code: "not_found" },
    });
    create.mockResolvedValueOnce(attempt.agent);
    getRun.mockResolvedValueOnce(confirmed({
      status: "finished",
      durationMs: 50000,
      requestId: "req-real",
      result: fenced,
    }));

    const decision = await triageFeedback("promo code does nothing", open);

    expect(decision).toEqual({
      action: "merge",
      issueNumber: 7,
      title: "Coupon case",
      body: "Trim and lowercase codes.",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledWith("run-id", {
      runtime: "cloud",
      agentId: AGENT,
      apiKey: API_KEY,
    });
    expect(attempt.close).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].name).toMatch(/^beanbox-triage-\d+-/);
    expect(create.mock.calls[0][0]).toMatchObject({
      apiKey: API_KEY,
      mode: "plan",
      cloud: { repos: [{ url: "https://github.com/acme/beanbox" }], autoCreatePR: false },
    });
    expect(attempt.send.mock.calls[0][0]).toContain("```json");
    expect(attempt.send.mock.calls[0][0]).toContain("promo code does nothing");
  });

  it("throws the confirmed error message, code, duration, request id, and a short preview", async () => {
    const tail = "TAIL-MARKER-SHOULD-BE-CUT";
    const long = `${"x".repeat(200)}${tail}`;
    create.mockResolvedValueOnce(
      fakeAgent({ status: "error", durationMs: 10, requestId: "req-first", result: "first" }).agent,
    );
    getRun.mockResolvedValueOnce(confirmed({
      status: "error",
      durationMs: 4321,
      requestId: "req-second",
      id: "run-second",
      error: { message: `failed near ${API_KEY}`, code: "boom" },
      result: `failed near ${API_KEY}\n${long}`,
    }));

    const err = await triageFeedback("cart total is wrong", open).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("Triage run error");
    expect(message).toContain("durationMs=4321");
    expect(message).toContain("requestId=req-second");
    expect(message).toContain('error="failed near [redacted]"');
    expect(message).toContain("code=boom");
    expect(message).not.toContain("req-first");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(tail);
    expect(message.length).toBeLessThan(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses the run id when requestId is missing and does not launch another agent after a confirmed cancel", async () => {
    create.mockResolvedValueOnce(
      fakeAgent({ status: "cancelled", durationMs: 90, id: "run-only", result: "stopped early" }).agent,
    );
    getRun.mockResolvedValueOnce(confirmed({
      status: "cancelled",
      durationMs: 90,
      id: "run-only",
      result: "stopped early",
    }));

    await expect(triageFeedback("something broke", [])).rejects.toThrow(
      /Triage run cancelled durationMs=90 requestId=run-only result="stopped early"/,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("still parses a bare JSON object and drops a merge target that is not open", async () => {
    create.mockResolvedValueOnce(
      fakeAgent({
        status: "finished",
        result: '{"action":"merge","issueNumber":99,"title":"New bug","body":"Not a duplicate."}',
      }).agent,
    );

    await expect(triageFeedback("brand new bug", open)).resolves.toEqual({
      action: "create",
      issueNumber: undefined,
      title: "New bug",
      body: "Not a duplicate.",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(getRun).not.toHaveBeenCalled();
  });

  it("on Vercel polls Agent.getRun and does not call wait()", async () => {
    process.env.VERCEL = "1";
    const fenced = [
      "```json",
      '{"action":"create","title":"Tote","body":"Cart skips the tote."}',
      "```",
    ].join("\n");
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    const conversation = vi.fn(async () => {
      throw new Error("conversation should not run when getRun already has JSON");
    });
    const attempt = fakeAgent({ status: "finished", result: "ignored" });
    attempt.agent.send.mockResolvedValue({ id: "run-id", agentId: AGENT, wait });
    create.mockResolvedValueOnce(attempt.agent);
    getRun.mockResolvedValueOnce({ ...confirmed({ status: "finished", result: fenced }), conversation });

    await expect(triageFeedback("the tote will not add", [])).resolves.toMatchObject({
      action: "create",
      title: "Tote",
    });
    expect(wait).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
    expect(getRun).toHaveBeenCalledOnce();
  });

  it("on Vercel reads the final assistant text from conversation when getRun result is empty", async () => {
    process.env.VERCEL = "1";
    const fenced = [
      "```json",
      '{"action":"create","title":"Tote","body":"Cart skips the tote."}',
      "```",
    ].join("\n");
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    const attempt = fakeAgent({ status: "finished", result: "ignored" });
    attempt.agent.send.mockResolvedValue({ id: "run-sse", agentId: AGENT, wait });
    create.mockResolvedValueOnce(attempt.agent);
    const observed = {
      ...confirmed({ id: "run-sse", status: "finished", result: "" }),
      async conversation(this: { result?: string }) {
        this.result = fenced;
        return [
          {
            type: "agentConversationTurn",
            turn: { steps: [{ type: "assistantMessage", message: { text: "looking" } }] },
          },
        ];
      },
    };
    const conversation = vi.spyOn(observed, "conversation");
    getRun.mockResolvedValueOnce(observed);

    await expect(triageFeedback("the tote will not add", [])).resolves.toEqual({
      action: "create",
      title: "Tote",
      body: "Cart skips the tote.",
    });
    expect(wait).not.toHaveBeenCalled();
    expect(conversation).toHaveBeenCalledOnce();
  });

  it("on Vercel uses an assistant step when the getRun snapshot text is not JSON", async () => {
    process.env.VERCEL = "1";
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    const attempt = fakeAgent({ status: "finished" });
    attempt.agent.send.mockResolvedValue({ id: "run-step", agentId: AGENT, wait });
    create.mockResolvedValueOnce(attempt.agent);
    getRun.mockResolvedValueOnce({
      ...confirmed({ id: "run-step", status: "finished", result: "Plan saved." }),
      conversation: async () => [
        {
          type: "agentConversationTurn",
          turn: {
            steps: [
              { type: "assistantMessage", message: { text: "Plan saved." } },
              {
                type: "assistantMessage",
                message: {
                  text: '{"action":"merge","issueNumber":7,"title":"Coupon case","body":"Trim codes."}',
                },
              },
            ],
          },
        },
      ],
    });

    await expect(triageFeedback("promo code does nothing", open)).resolves.toEqual({
      action: "merge",
      issueNumber: 7,
      title: "Coupon case",
      body: "Trim codes.",
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("logs the run id, status, and a redacted preview when no JSON is found", async () => {
    process.env.VERCEL = "1";
    const tail = "TAIL-MARKER-SHOULD-BE-CUT";
    const received = `model said ${API_KEY} ${"x".repeat(200)}${tail}`;
    const attempt = fakeAgent({ status: "finished" });
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    attempt.agent.send.mockResolvedValue({ id: "run-empty", agentId: AGENT, wait });
    create.mockResolvedValueOnce(attempt.agent);
    getRun.mockResolvedValueOnce({
      ...confirmed({ id: "run-empty", status: "finished", result: received }),
      conversation: async () => [],
    });

    const err = await triageFeedback("nothing useful", []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("Triage returned no JSON");
    expect(message).toContain("runId=run-empty");
    expect(message).toContain("status=finished");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(tail);
  });

  it("names an empty reply in the parse error", async () => {
    process.env.VERCEL = "1";
    const attempt = fakeAgent({ status: "finished" });
    const wait = vi.fn(async () => {
      throw new Error("wait should not run on Vercel");
    });
    attempt.agent.send.mockResolvedValue({ id: "run-blank", agentId: AGENT, wait });
    create.mockResolvedValueOnce(attempt.agent);
    getRun.mockResolvedValueOnce({
      ...confirmed({ id: "run-blank", status: "finished", result: "   " }),
      conversation: async () => [],
    });

    await expect(triageFeedback("blank reply", [])).rejects.toThrow(
      /Triage returned no JSON runId=run-blank status=finished received="\(empty\)"/,
    );
  });

  it("parses a fenced decision when an earlier note also contains braces", async () => {
    const wrapped = [
      "I checked {the cart}.",
      "```json",
      '{"action":"create","title":"Tote","body":"Cart skips the tote."}',
      "```",
    ].join("\n");
    create.mockResolvedValueOnce(fakeAgent({ status: "finished", result: wrapped }).agent);

    await expect(triageFeedback("the tote will not add", [])).resolves.toEqual({
      action: "create",
      title: "Tote",
      body: "Cart skips the tote.",
    });
    expect(getRun).not.toHaveBeenCalled();
  });
});
