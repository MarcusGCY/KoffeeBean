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
  git?: { branches: { repoUrl: string; branch?: string; prUrl?: string }[] };
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
    git: result.git,
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
  delete process.env.TRIAGE_MODEL;
  delete process.env.FIX_MODEL;
});

afterEach(() => {
  delete process.env.VERCEL;
});

describe("triageFeedback", () => {
  it("keeps a finished triage run when wait() reports a false error", async () => {
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
      agentId: AGENT,
      runId: "run-id",
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
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      mode: "agent",
      cloud: {
        repos: [{ url: "https://github.com/acme/beanbox", startingRef: "main" }],
        autoCreatePR: false,
      },
    });
    expect(attempt.send.mock.calls[0][0]).toContain(".cursor/rules/triage.mdc");
    expect(attempt.send.mock.calls[0][0]).toContain(".cursor/skills/write-repro-test/SKILL.md");
    expect(attempt.send.mock.calls[0][0]).toContain(".cursor/skills/pre-pr-self-check/SKILL.md");
    expect(attempt.send.mock.calls[0][0]).toContain("```json");
    expect(attempt.send.mock.calls[0][0]).toContain("tests/repro/");
    expect(attempt.send.mock.calls[0][0]).toContain("beanbox-triage/<slug>-bc-00000");
    expect(attempt.send.mock.calls[0][0]).toContain("git fetch origin main");
    expect(attempt.send.mock.calls[0][0]).toContain("Never reuse or check out an existing branch");
    expect(attempt.send.mock.calls[0][0]).toContain("no edits under src/");
    expect(attempt.send.mock.calls[0][0]).toContain("promo code does nothing");
  });

  it("names the provisional case id and does not invent an issue number", async () => {
    const made = fakeAgent({
      status: "finished",
      result: '{"action":"create","title":"Tote","body":"Cart skips the tote."}',
    });
    create.mockResolvedValueOnce(made.agent);
    await triageFeedback("the tote will not add", [], { caseId: "kb-0123456789abcdef" });
    const sent = made.send.mock.calls[0][0] as string;
    expect(sent).toContain("Provisional case token: kb-0123456789abcdef");
    expect(sent).toContain("tests/repro/kb-0123456789abcdef-<slug>.test.ts");
    expect(sent).toContain("beanbox-triage/kb-0123456789abcdef-<slug>-bc-00000");
    expect(sent).toContain("Do not invent an issue number");
    expect(sent).not.toContain("issue-");
  });

  it("rejects a new repro that omits the case token and keeps one that includes it", async () => {
    const missing = fakeAgent({
      status: "finished",
      result: '{"action":"create","title":"Tote","body":"Cart skips the tote.","testPath":"tests/repro/tote-add.test.ts"}',
    });
    create.mockResolvedValueOnce(missing.agent);
    const rejected = await triageFeedback("the tote will not add", [], { caseId: "kb-0123456789abcdef" });
    expect(rejected.identityMismatch).toEqual({
      expected: "kb-0123456789abcdef",
      testPath: "tests/repro/tote-add.test.ts",
      branch: "beanbox-triage/tote-add-bc-00000",
    });
    expect(rejected.testPath).toBeUndefined();
    expect(rejected.branch).toBeUndefined();

    const matched = fakeAgent({
      status: "finished",
      result: '{"action":"create","title":"Tote","body":"Cart skips the tote.","testPath":"tests/repro/kb-0123456789abcdef-tote-add.test.ts"}',
    });
    create.mockResolvedValueOnce(matched.agent);
    const accepted = await triageFeedback("the tote will not add", [], { caseId: "kb-0123456789abcdef" });
    expect(accepted.identityMismatch).toBeUndefined();
    expect(accepted.testPath).toBe("tests/repro/kb-0123456789abcdef-tote-add.test.ts");
    expect(accepted.branch).toBe("beanbox-triage/kb-0123456789abcdef-tote-add-bc-00000");
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

  it("uses the exact branch for this run instead of the branch the agent reported", async () => {
    const fenced = [
      "```json",
      '{"action":"create","title":"Tote","body":"Cart skips the tote.","testPath":"tests/repro/tote-add.test.ts","branch":"beanbox-triage/tote-add"}',
      "```",
    ].join("\n");
    create.mockResolvedValueOnce(fakeAgent({
      status: "finished",
      result: fenced,
      git: { branches: [{ repoUrl: "https://github.com/acme/beanbox", branch: "refs/heads/cursor/triage-tote" }] },
    }).agent);

    await expect(triageFeedback("the tote will not add", [])).resolves.toEqual({
      action: "create",
      title: "Tote",
      body: "Cart skips the tote.",
      testPath: "tests/repro/tote-add.test.ts",
      branch: "beanbox-triage/tote-add-bc-00000",
      agentId: AGENT,
      runId: "run-id",
    });
  });

  it("drops a test path that is not under tests/repro", async () => {
    create.mockResolvedValueOnce(fakeAgent({
      status: "finished",
      result: '{"action":"create","title":"Nope","body":"Bad path.","testPath":"src/lib/cart.ts"}',
    }).agent);

    await expect(triageFeedback("bad path", [])).resolves.toEqual({
      action: "create",
      title: "Nope",
      body: "Bad path.",
      agentId: AGENT,
      runId: "run-id",
    });
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
      agentId: AGENT,
      runId: "run-id",
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
      agentId: AGENT,
      runId: "run-sse",
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
      agentId: AGENT,
      runId: "run-step",
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
      agentId: AGENT,
      runId: "run-id",
    });
    expect(getRun).not.toHaveBeenCalled();
  });
});
