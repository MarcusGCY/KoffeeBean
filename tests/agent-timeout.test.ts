import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@grok/agent-sdk", () => ({
  serve: async () => ({
    url: "http://127.0.0.1:9",
    agents: [{ url: "http://127.0.0.1:9", slug: "" }],
    close: async () => {},
  }),
}));

import { askSupportAgent, SupportTimeoutError } from "@/lib/agent-chat";

describe("support run timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CURSOR_API_KEY;
    delete process.env.APPROVAL_SECRET;
  });

  it("cancels the agent session when the run budget expires", async () => {
    process.env.CURSOR_API_KEY = "cursor-test";
    process.env.APPROVAL_SECRET = "test-secret";
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (method === "POST" && url.endsWith("/v1/session")) {
          return Promise.resolve(Response.json({ ok: true, sessionId: "ses_hang", continuationToken: "tok" }));
        }
        if (method === "POST" && url.endsWith("/stop")) {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(init?.signal?.aborted).toBe(false);
          return Promise.resolve(Response.json({ ok: true, interrupted: true }));
        }
        return new Promise((_resolve, reject) => {
          const abort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }),
    );

    await expect(askSupportAgent({ userId: "auth0|shopper", message: "hello" }, 30)).rejects.toBeInstanceOf(
      SupportTimeoutError,
    );
    expect(calls).toContainEqual({
      url: "http://127.0.0.1:9/v1/session/ses_hang/stop",
      method: "POST",
    });
  });

  it("stops a session whose id arrived before the open body finished", async () => {
    process.env.CURSOR_API_KEY = "cursor-test";
    process.env.APPROVAL_SECRET = "test-secret";
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (method === "POST" && url.endsWith("/v1/session")) {
          const stream = new ReadableStream({
            start(controller) {
              const abort = () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
              if (init?.signal?.aborted) abort();
              else init?.signal?.addEventListener("abort", abort, { once: true });
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-agent-serve-session-id": "ses_early",
              },
            }),
          );
        }
        if (method === "POST" && url.endsWith("/v1/session/ses_early/stop")) {
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(init?.signal?.aborted).toBe(false);
          return Promise.resolve(Response.json({ ok: true, interrupted: true }));
        }
        return Promise.resolve(Response.json({ events: [] }));
      }),
    );

    await expect(askSupportAgent({ userId: "auth0|shopper", message: "hello" }, 30)).rejects.toBeInstanceOf(
      SupportTimeoutError,
    );
    expect(calls).toContainEqual({
      url: "http://127.0.0.1:9/v1/session/ses_early/stop",
      method: "POST",
    });
  });
});
