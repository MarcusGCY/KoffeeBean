import { afterEach, describe, expect, it } from "vitest";
import {
  adminEmailAllowlist,
  demoCsrfToken,
  isAdminEmail,
  isSameOrigin,
  resetGrant,
  revertGrant,
  verifyDemoCsrf,
  verifyResetGrant,
  verifyRevertGrant,
} from "@/lib/demo-auth";
import {
  commitIsLive,
  mainIsDeploying,
  parseResetMarker,
  parseRevertMarker,
  pullNumberFromSubject,
  pullNumbersFromText,
  resetCommitMessage,
  revertCommitMessage,
  revertsByPull,
  statusLabel,
} from "@/lib/demo-status";

const NOW = 1_700_000_000_000;

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  delete process.env.APPROVAL_SECRET;
});

describe("admin allowlist", () => {
  it("matches comma-separated emails and nobody when unset", () => {
    expect(isAdminEmail("marcusgcy@gmail.com")).toBe(false);
    process.env.ADMIN_EMAILS = " MarcusGCY@gmail.com , other@example.com ";
    expect(adminEmailAllowlist()).toEqual(["marcusgcy@gmail.com", "other@example.com"]);
    expect(isAdminEmail("marcusgcy@gmail.com")).toBe(true);
    expect(isAdminEmail("shopper@example.com")).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});

describe("demo grants", () => {
  it("signs csrf and revert tokens for one user and one pull request", () => {
    process.env.APPROVAL_SECRET = "test-approval-secret";
    const csrf = demoCsrfToken("auth0|marcus", NOW);
    expect(verifyDemoCsrf("auth0|marcus", csrf, NOW + 1000)).toBe(true);
    expect(verifyDemoCsrf("auth0|other", csrf, NOW + 1000)).toBe(false);
    expect(verifyDemoCsrf("auth0|marcus", csrf, NOW + 3 * 60 * 60 * 1000)).toBe(false);

    const grant = revertGrant(23, NOW);
    expect(verifyRevertGrant(23, grant, NOW + 1000)).toBe(true);
    expect(verifyRevertGrant(24, grant, NOW + 1000)).toBe(false);
    expect(verifyRevertGrant(23, grant, NOW + 25 * 60 * 60 * 1000)).toBe(false);
    expect(verifyRevertGrant(23, "1.abcd", NOW)).toBe(false);

    const reset = resetGrant(NOW);
    expect(verifyResetGrant(reset, NOW + 1000)).toBe(true);
    expect(verifyResetGrant(grant, NOW + 1000)).toBe(false);
  });
});

describe("same origin", () => {
  it("accepts the request host and rejects a foreign origin", () => {
    const same = new Request("https://koffee-bean.vercel.app/api/demo/revert", {
      method: "POST",
      headers: {
        origin: "https://koffee-bean.vercel.app",
        host: "koffee-bean.vercel.app",
      },
    });
    const forwarded = new Request("https://internal.local/api/demo/revert", {
      method: "POST",
      headers: {
        origin: "https://koffee-bean.vercel.app",
        "x-forwarded-host": "koffee-bean.vercel.app",
        host: "internal.local",
      },
    });
    const cross = new Request("https://koffee-bean.vercel.app/api/demo/revert", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        host: "koffee-bean.vercel.app",
      },
    });
    const bare = new Request("https://koffee-bean.vercel.app/api/demo/revert", { method: "POST" });
    expect(isSameOrigin(same)).toBe(true);
    expect(isSameOrigin(forwarded)).toBe(true);
    expect(isSameOrigin(cross)).toBe(false);
    expect(isSameOrigin(bare)).toBe(false);
  });
});

describe("revert markers", () => {
  it("does not look like a squash-merge subject and round-trips", () => {
    const message = revertCommitMessage({
      issue: 22,
      pr: 23,
      mergeSha: "8d8e16f81e5fb15b8ec0a063b3033c4f02933612",
      title: "Coffee bean product images do not load",
    });
    expect(pullNumberFromSubject(message)).toBeUndefined();
    expect(parseRevertMarker(message)).toEqual({
      issue: 22,
      pr: 23,
      merge: "8d8e16f81e5fb15b8ec0a063b3033c4f02933612",
    });
    expect(pullNumberFromSubject("Fix coffee bean product image URLs. (#23)")).toBe(23);
    expect(pullNumbersFromText(
      "Cursor opened a fix: https://github.com/MarcusGCY/KoffeeBean/pull/23",
      "MarcusGCY/KoffeeBean",
    )).toEqual([23]);
  });

  it("lets the newest reset or revert win, and knows what is deployed", () => {
    const reset = resetCommitMessage("5cb688963970c83b30bcef265506a58b12084250", [23]);
    expect(parseResetMarker(reset)?.reverts).toEqual([23]);
    const commits = [
      { sha: "reset", message: reset },
      { sha: "revert", message: revertCommitMessage({ pr: 23, mergeSha: "merge" }) },
      { sha: "merge", message: "Fix images. (#23)" },
    ];
    expect(revertsByPull(commits).get(23)).toBe("reset");
    expect(commitIsLive(commits, "merge", "reset")).toBe(false);
    expect(commitIsLive(commits, "reset", "merge")).toBe(true);
    expect(commitIsLive(commits, undefined, "reset")).toBe(true);
    expect(mainIsDeploying("reset", "merge")).toBe(true);
    expect(mainIsDeploying("reset", undefined)).toBe(false);
    expect(statusLabel("reverted", true)).toBe("Reverted · deploying");
    expect(statusLabel("merged", false)).toBe("Merged");
    expect(statusLabel("unmerged", false)).toBe("Not merged");
  });
});
