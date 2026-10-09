import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyMergeToken } from "@/lib/merge-link";
import { notifyFixCompleted, notifyFixMerged, notifyFixStarted, requestReview } from "@/lib/notify";

const issue = {
  number: 7,
  title: "Promo code ignored",
  url: "https://github.com/example/beanbox/issues/7",
  summary: "SAVE10 does nothing",
};

const envKeys = ["APP_URL", "APPROVAL_SECRET", "GROK_WEBHOOK_URL", "GROK_WEBHOOK_AUTH", "GITHUB_REPO"] as const;
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

function postedJson(): {
  type: string;
  issue: { number: number; title: string; url: string };
  status?: string;
  prUrl?: string;
  prNumber?: number;
  mergeUrl?: string;
  sha?: string;
  summary?: string;
} {
  const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

describe("fix progress webhooks", () => {
  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubWebhook(auth?: string, response: { ok: boolean; status: number } | Error = { ok: true, status: 200 }) {
    for (const key of envKeys) saved[key] = process.env[key];
    process.env.APP_URL = "http://localhost:3000";
    process.env.APPROVAL_SECRET = "test-secret";
    process.env.GROK_WEBHOOK_URL = "https://hooks.example/grok";
    if (auth === undefined) delete process.env.GROK_WEBHOOK_AUTH;
    else process.env.GROK_WEBHOOK_AUTH = auth;
    const fetchMock = vi.fn().mockImplementation(() => {
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("posts fix_started with the issue and the same Authorization header", async () => {
    stubWebhook("Authorization: Bearer secret");
    await notifyFixStarted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
    });
    expect(authHeader()).toBe("Bearer secret");
    expect(postedJson()).toEqual({
      type: "fix_started",
      issue: {
        number: 7,
        title: "Bean images not loading",
        url: "https://github.com/example/beanbox/issues/7",
      },
    });
  });

  it("posts fix_completed with status, prUrl, and the GitHub comment", async () => {
    stubWebhook("Bearer secret");
    process.env.GITHUB_REPO = "example/beanbox";
    await notifyFixCompleted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      status: "finished",
      prUrl: "https://github.com/example/beanbox/pull/9",
      summary: "Cursor opened a fix: https://github.com/example/beanbox/pull/9",
    });
    expect(authHeader()).toBe("Bearer secret");
    const body = postedJson();
    expect(body).toMatchObject({
      type: "fix_completed",
      issue: { number: 7, title: "Bean images not loading", url: "https://github.com/example/beanbox/issues/7" },
      status: "finished",
      prUrl: "https://github.com/example/beanbox/pull/9",
      prNumber: 9,
      summary: "Cursor opened a fix: https://github.com/example/beanbox/pull/9",
    });
    const merge = new URL(body.mergeUrl ?? "");
    expect(merge.origin).toBe("http://localhost:3000");
    expect(merge.pathname).toBe("/api/merge");
    expect(merge.searchParams.get("issue")).toBe("7");
    expect(merge.searchParams.get("pr")).toBe("9");
    expect(verifyMergeToken(7, 9, merge.searchParams.get("token") ?? "")).toBe("ok");
  });

  it("omits prUrl when the run did not open one", async () => {
    stubWebhook();
    process.env.GITHUB_REPO = "example/beanbox";
    await notifyFixCompleted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      status: "error",
      summary: "Cursor run ended with status `error`. No PR was created.",
    });
    expect(postedJson().prUrl).toBeUndefined();
    expect(postedJson().prNumber).toBeUndefined();
    expect(postedJson().mergeUrl).toBeUndefined();
    expect(postedJson().summary).toContain("No PR was created.");
  });

  it("omits the merge link when the pull request is in another repository", async () => {
    stubWebhook();
    process.env.GITHUB_REPO = "example/beanbox";
    await notifyFixCompleted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      status: "finished",
      prUrl: "https://github.com/other/repo/pull/9",
      summary: "Cursor opened a fix: https://github.com/other/repo/pull/9",
    });
    expect(postedJson().prUrl).toBe("https://github.com/other/repo/pull/9");
    expect(postedJson().prNumber).toBeUndefined();
    expect(postedJson().mergeUrl).toBeUndefined();
  });

  it("posts fix_merged with the pull request and the merge commit", async () => {
    stubWebhook("Authorization: Bearer secret");
    await notifyFixMerged({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      prNumber: 9,
      prUrl: "https://github.com/example/beanbox/pull/9",
      sha: "a".repeat(40),
    });
    expect(authHeader()).toBe("Bearer secret");
    expect(postedJson()).toEqual({
      type: "fix_merged",
      issue: {
        number: 7,
        title: "Bean images not loading",
        url: "https://github.com/example/beanbox/issues/7",
      },
      prNumber: 9,
      prUrl: "https://github.com/example/beanbox/pull/9",
      sha: "a".repeat(40),
      summary: "Squash-merged pull request #9. Vercel will redeploy main shortly.",
    });
  });

  it("still posts fix_completed when the merge link cannot be signed", async () => {
    stubWebhook();
    process.env.GITHUB_REPO = "example/beanbox";
    delete process.env.APPROVAL_SECRET;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyFixCompleted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      status: "finished",
      prUrl: "https://github.com/example/beanbox/pull/9",
      summary: "Cursor opened a fix: https://github.com/example/beanbox/pull/9",
    });
    expect(postedJson()).toMatchObject({
      type: "fix_completed",
      prUrl: "https://github.com/example/beanbox/pull/9",
      prNumber: 9,
      summary: "Cursor opened a fix: https://github.com/example/beanbox/pull/9",
    });
    expect(postedJson().mergeUrl).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("logs and resolves when the webhook fails", async () => {
    stubWebhook(undefined, new Error("network down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyFixStarted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
    })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it("logs and resolves when the webhook returns a non-ok status", async () => {
    stubWebhook(undefined, { ok: false, status: 500 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyFixCompleted({
      number: 7,
      title: "Bean images not loading",
      url: "https://github.com/example/beanbox/issues/7",
      status: "finished",
      summary: "Cursor opened a fix: https://github.com/example/beanbox/pull/9",
    })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
