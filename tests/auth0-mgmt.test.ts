import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppMetadata, getManagementToken, patchAppMetadata, resetManagementTokenCache } from "@/lib/auth0-mgmt";

const calls: { url: string; method: string; body?: string; auth?: string | null }[] = [];

describe("auth0 management", () => {
  beforeEach(() => {
    calls.length = 0;
    resetManagementTokenCache();
    process.env.AUTH0_DOMAIN = "https://tenant.example.auth0.com/";
    process.env.AUTH0_MGMT_CLIENT_ID = "mgmt-id";
    process.env.AUTH0_MGMT_CLIENT_SECRET = "mgmt-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body == null ? undefined : String(init.body),
          auth: headers.get("authorization"),
        });
        if (String(input).endsWith("/oauth/token")) {
          return Response.json({ access_token: `token-${calls.length}`, expires_in: 3600 });
        }
        return Response.json({ app_metadata: { orders: [{ id: "BB-1" }] } });
      }),
    );
  });

  afterEach(() => {
    resetManagementTokenCache();
    vi.unstubAllGlobals();
    delete process.env.AUTH0_DOMAIN;
    delete process.env.AUTH0_MGMT_CLIENT_ID;
    delete process.env.AUTH0_MGMT_CLIENT_SECRET;
  });

  it("caches the client-credentials token until near expiry", async () => {
    const start = 1_700_000_000_000;
    expect(await getManagementToken(start)).toBe("token-1");
    expect(await getManagementToken(start + 1_000)).toBe("token-1");
    expect(await getManagementToken(start + 3600 * 1000 - 30_000)).toMatch(/^token-/);
    const tokenCalls = calls.filter((call) => call.url.endsWith("/oauth/token"));
    expect(tokenCalls).toHaveLength(2);
    expect(JSON.parse(tokenCalls[0]?.body ?? "{}")).toMatchObject({
      grant_type: "client_credentials",
      client_id: "mgmt-id",
      audience: "https://tenant.example.auth0.com/api/v2/",
    });
  });

  it("reads and patches app_metadata, sending only the top-level keys in the patch", async () => {
    const meta = await getAppMetadata("auth0|user");
    expect(meta).toEqual({ orders: [{ id: "BB-1" }] });
    await patchAppMetadata("auth0|user", { cart: { items: [], coupon: null } });
    const userCalls = calls.filter((call) => call.url.includes("/api/v2/users/"));
    expect(userCalls[0]?.url).toBe("https://tenant.example.auth0.com/api/v2/users/auth0%7Cuser");
    expect(userCalls[1]?.method).toBe("PATCH");
    expect(JSON.parse(userCalls[1]?.body ?? "{}")).toEqual({
      app_metadata: { cart: { items: [], coupon: null } },
    });
    expect(userCalls[1]?.auth).toMatch(/^Bearer token-/);
  });
});
