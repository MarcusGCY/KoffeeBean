import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Agent: { create },
}));

import { triageFeedback } from "@/lib/triage";
import type { OpenIssue } from "@/lib/github";

const API_KEY = "test-cursor-key-do-not-log";
const open: OpenIssue[] = [{ number: 7, title: "Coupon ignored", body: "SAVE10 does nothing when typed in lowercase." }];

type Status = "finished" | "error" | "cancelled";

function fakeAgent(result: {
  status: Status;
  result?: string;
  durationMs?: number;
  requestId?: string;
  id?: string;
}) {
  const close = vi.fn();
  const wait = vi.fn(async () => ({
    id: result.id ?? "run-id",
    requestId: result.requestId,
    durationMs: result.durationMs,
    status: result.status,
    result: result.result,
  }));
  const send = vi.fn(async (_prompt: string) => ({ wait }));
  return { close, send, agent: { send, close } };
}

beforeEach(() => {
  create.mockReset();
  process.env.CURSOR_API_KEY = API_KEY;
  process.env.GITHUB_REPO = "acme/beanbox";
});

describe("triageFeedback", () => {
  it("retries once after status error and parses a json fence", async () => {
    const failed = fakeAgent({
      status: "error",
      durationMs: 800,
      requestId: "req-first",
      result: "partial",
    });
    const fenced = [
      "Different wording, same coupon bug.",
      "```json",
      '{"action":"merge","issueNumber":7,"title":"Coupon case","body":"Trim and lowercase codes."}',
      "```",
    ].join("\n");
    const ok = fakeAgent({
      status: "finished",
      durationMs: 50000,
      requestId: "req-second",
      result: fenced,
    });
    create.mockResolvedValueOnce(failed.agent).mockResolvedValueOnce(ok.agent);

    const decision = await triageFeedback("promo code does nothing", open);

    expect(decision).toEqual({
      action: "merge",
      issueNumber: 7,
      title: "Coupon case",
      body: "Trim and lowercase codes.",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(failed.close).toHaveBeenCalledOnce();
    expect(ok.close).toHaveBeenCalledOnce();
    const names = create.mock.calls.map((call) => call[0].name as string);
    expect(names[0]).toMatch(/^beanbox-triage-\d+-/);
    expect(names[1]).toMatch(/^beanbox-triage-\d+-/);
    expect(names[0]).not.toBe(names[1]);
    expect(create.mock.calls[0][0]).toMatchObject({
      apiKey: API_KEY,
      mode: "plan",
      cloud: { repos: [{ url: "https://github.com/acme/beanbox" }], autoCreatePR: false },
    });
    expect(ok.send.mock.calls[0][0]).toContain("```json");
    expect(ok.send.mock.calls[0][0]).toContain("promo code does nothing");
  });

  it("throws status, duration, request id, and a short preview after the second error", async () => {
    const tail = "TAIL-MARKER-SHOULD-BE-CUT";
    const long = `${"x".repeat(200)}${tail}`;
    create
      .mockResolvedValueOnce(
        fakeAgent({ status: "error", durationMs: 10, requestId: "req-first", result: "first" }).agent,
      )
      .mockResolvedValueOnce(
        fakeAgent({
          status: "error",
          durationMs: 4321,
          requestId: "req-second",
          id: "run-second",
          result: `failed near ${API_KEY}\n${long}`,
        }).agent,
      );

    const err = await triageFeedback("cart total is wrong", open).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("Triage run error");
    expect(message).toContain("durationMs=4321");
    expect(message).toContain("requestId=req-second");
    expect(message).not.toContain("req-first");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(tail);
    expect(message.length).toBeLessThan(400);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("uses the run id when requestId is missing and does not retry a cancel", async () => {
    create.mockResolvedValueOnce(
      fakeAgent({ status: "cancelled", durationMs: 90, id: "run-only", result: "stopped early" }).agent,
    );

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
  });
});
