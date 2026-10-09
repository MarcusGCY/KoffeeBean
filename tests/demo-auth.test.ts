import { afterEach, describe, expect, it } from "vitest";
import { filterDefaultIdTokenClaims } from "@auth0/nextjs-auth0/server";
import { userKeepingRolesClaim } from "@/lib/auth0";
import {
  demoCsrfToken,
  hasAdminRole,
  isAdminUser,
  isSameOrigin,
  resetGrant,
  revertGrant,
  rolesClaimName,
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
  delete process.env.AUTH0_ROLES_CLAIM;
  delete process.env.APPROVAL_SECRET;
});

function sessionUser(roles: unknown, claim = "https://beanbox/roles") {
  return {
    sub: "auth0|marcus",
    email: "marcusgcy@gmail.com",
    email_verified: true,
    [claim]: roles,
  };
}

describe("admin role", () => {
  it("accepts an array or a single string that contains admin", () => {
    expect(rolesClaimName()).toBe("https://beanbox/roles");
    expect(hasAdminRole(undefined)).toBe(false);
    expect(hasAdminRole(sessionUser(undefined))).toBe(false);
    expect(hasAdminRole(sessionUser(["shopper"]))).toBe(false);
    expect(hasAdminRole(sessionUser(["shopper", "admin"]))).toBe(true);
    expect(hasAdminRole(sessionUser("admin"))).toBe(true);
    expect(hasAdminRole(sessionUser(" admin "))).toBe(true);
    expect(hasAdminRole(sessionUser("shopper"))).toBe(false);
    expect(hasAdminRole(sessionUser("admin,shopper"))).toBe(false);
    expect(hasAdminRole(sessionUser([" Admin "]))).toBe(false);
    expect(hasAdminRole(sessionUser(["admin", 1, "", "  "]))).toBe(true);
    expect(hasAdminRole(sessionUser({ role: "admin" }))).toBe(false);

    expect(isAdminUser(sessionUser(["admin"]))).toBe(true);
    expect(isAdminUser({ ...sessionUser(["admin"]), email_verified: false })).toBe(false);
    expect(isAdminUser({ ...sessionUser(["admin"]), email: undefined })).toBe(false);
    expect(isAdminUser({ ...sessionUser(["admin"]), sub: "" })).toBe(false);
  });

  it("reads AUTH0_ROLES_CLAIM and ignores a blank override", () => {
    process.env.AUTH0_ROLES_CLAIM = " https://beanbox.example/roles ";
    expect(rolesClaimName()).toBe("https://beanbox.example/roles");
    expect(hasAdminRole(sessionUser(["admin"], "https://beanbox.example/roles"))).toBe(true);
    expect(hasAdminRole(sessionUser(["admin"]))).toBe(false);
    process.env.AUTH0_ROLES_CLAIM = "   ";
    expect(rolesClaimName()).toBe("https://beanbox/roles");
    expect(hasAdminRole(sessionUser("admin"))).toBe(true);
  });

  it("keeps the roles claim on the session and drops other ID token claims", () => {
    const user = {
      sub: "auth0|marcus",
      name: "Marcus",
      email: "marcusgcy@gmail.com",
      email_verified: true,
      iss: "https://koffeebean.jp.auth0.com/",
      aud: "client-id",
      "https://beanbox/roles": ["admin"],
      "https://beanbox/extra": "drop-me",
    };
    expect(filterDefaultIdTokenClaims(user)).not.toHaveProperty("https://beanbox/roles");
    const saved = userKeepingRolesClaim(user);
    expect(saved.email).toBe("marcusgcy@gmail.com");
    expect(saved.name).toBe("Marcus");
    expect(saved["https://beanbox/roles"]).toEqual(["admin"]);
    expect(saved).not.toHaveProperty("iss");
    expect(saved).not.toHaveProperty("aud");
    expect(saved).not.toHaveProperty("https://beanbox/extra");

    process.env.AUTH0_ROLES_CLAIM = "https://beanbox.example/roles";
    const custom = userKeepingRolesClaim({
      sub: "auth0|marcus",
      email: "marcusgcy@gmail.com",
      "https://beanbox.example/roles": "admin",
      "https://beanbox/roles": ["admin"],
    });
    expect(custom["https://beanbox.example/roles"]).toBe("admin");
    expect(custom).not.toHaveProperty("https://beanbox/roles");
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
