import { describe, expect, it } from "vitest";
import { MERGE_LINK_TTL_MS, mergeLink, mergeToken, prNumberFromUrl, verifyMergeToken } from "@/lib/merge-link";

describe("merge links", () => {
  it("accepts a token for the same issue and pull request until it expires", () => {
    process.env.APPROVAL_SECRET = "test-secret";
    const now = 1_700_000_000_000;
    const token = mergeToken(12, 34, now);
    expect(verifyMergeToken(12, 34, token, now + 1000)).toBe("ok");
    expect(verifyMergeToken(12, 34, token, now + MERGE_LINK_TTL_MS - 1)).toBe("ok");
    expect(verifyMergeToken(12, 34, token, now + MERGE_LINK_TTL_MS)).toBe("expired");
    expect(verifyMergeToken(11, 34, token, now)).toBe("invalid");
    expect(verifyMergeToken(12, 35, token, now)).toBe("invalid");
    expect(verifyMergeToken(12, 34, `${token.slice(0, -1)}0`, now)).toBe("invalid");
    expect(verifyMergeToken(12, 34, "not-a-token", now)).toBe("invalid");
  });

  it("builds a GET url bound to that issue and pull request", () => {
    process.env.APPROVAL_SECRET = "test-secret";
    process.env.APP_URL = "https://koffee-bean.vercel.app";
    const url = new URL(mergeLink(12, 34, 1_700_000_000_000));
    expect(url.origin).toBe("https://koffee-bean.vercel.app");
    expect(url.pathname).toBe("/api/merge");
    expect(url.searchParams.get("issue")).toBe("12");
    expect(url.searchParams.get("pr")).toBe("34");
    expect(verifyMergeToken(12, 34, url.searchParams.get("token") ?? "", 1_700_000_000_000)).toBe("ok");
  });

  it("reads a pull number only for the configured repository", () => {
    expect(prNumberFromUrl("https://github.com/acme/beanbox/pull/15", "acme/beanbox")).toBe(15);
    expect(prNumberFromUrl("https://github.com/ACME/Beanbox/pull/15/", "acme/beanbox")).toBe(15);
    expect(prNumberFromUrl("https://github.com/other/beanbox/pull/15", "acme/beanbox")).toBeUndefined();
    expect(prNumberFromUrl("https://github.com/acme/beanbox/issues/15", "acme/beanbox")).toBeUndefined();
    expect(prNumberFromUrl("not a url", "acme/beanbox")).toBeUndefined();
  });
});
