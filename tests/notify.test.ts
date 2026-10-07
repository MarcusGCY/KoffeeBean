import { afterEach, describe, expect, it, vi } from "vitest";
import { requestReview } from "@/lib/notify";

const issue = {
  number: 7,
  title: "Promo code ignored",
  url: "https://github.com/example/beanbox/issues/7",
  summary: "SAVE10 does nothing",
};

const envKeys = ["APP_URL", "APPROVAL_SECRET", "GROK_WEBHOOK_URL", "GROK_WEBHOOK_AUTH"] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

function authHeader(): string | undefined {
  const fetchMock = vi.mocked(fetch);
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.authorization;
}

describe("GROK_WEBHOOK_AUTH", () => {
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubWebhook(auth?: string) {
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.APP_URL = "http://localhost:3000";
    process.env.APPROVAL_SECRET = "test-secret";
    process.env.GROK_WEBHOOK_URL = "https://hooks.example/grok";
    if (auth === undefined) delete process.env.GROK_WEBHOOK_AUTH;
    else process.env.GROK_WEBHOOK_AUTH = auth;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  }

  it("sends a trimmed Bearer value as the Authorization header", async () => {
    stubWebhook("  Bearer secret  ");
    await requestReview(issue);
    expect(authHeader()).toBe("Bearer secret");
  });

  it("strips a pasted Authorization: prefix so the header is not doubled", async () => {
    stubWebhook("Authorization: Bearer secret");
    await requestReview(issue);
    expect(authHeader()).toBe("Bearer secret");
  });

  it("strips the prefix case-insensitively and trims the remaining value", async () => {
    stubWebhook("  aUtHoRiZaTiOn:   Bearer secret  ");
    await requestReview(issue);
    expect(authHeader()).toBe("Bearer secret");
  });

  it("leaves a value that only contains the word Authorization later unchanged", async () => {
    stubWebhook("Bearer Authorization: not-a-prefix");
    await requestReview(issue);
    expect(authHeader()).toBe("Bearer Authorization: not-a-prefix");
  });

  it("omits the header when the variable is unset", async () => {
    stubWebhook();
    await requestReview(issue);
    expect(authHeader()).toBeUndefined();
  });
});
