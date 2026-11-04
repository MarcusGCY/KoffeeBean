import { afterEach, describe, expect, it, vi } from "vitest";
import { XAI_CHAT_URL, runXaiChat } from "@/lib/xai-chat";

const sink = {
  status: () => {},
  products: () => {},
  text: () => {},
  confirm: () => {},
  order: () => {},
  error: () => {},
};

describe("xAI chat timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.XAI_API_KEY;
    delete process.env.APPROVAL_SECRET;
  });

  it("aborts the xAI request and does not call a session stop URL", async () => {
    process.env.XAI_API_KEY = "xai-test-key-do-not-leak";
    process.env.APPROVAL_SECRET = "test-secret";
    const calls: string[] = [];
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        return new Promise((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }),
    );
    const timer = setTimeout(() => controller.abort(), 30);
    await expect(
      runXaiChat({
        userId: "auth0|shopper",
        turns: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        sink,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    clearTimeout(timer);
    expect(calls).toEqual([XAI_CHAT_URL]);
  });
});
