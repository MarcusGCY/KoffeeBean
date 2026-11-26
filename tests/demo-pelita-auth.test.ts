import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { proxy } from "@/proxy";
import { getShopper } from "@/lib/shopper";
import { loadScenario } from "@/lib/demo/scenario";
import { storefrontView } from "@/lib/demo/storefront";
import { absoluteLogoutReturnTo, prepareAuthReturnTo } from "@/lib/auth-return";
import { PELITA_SIGN_IN_HREF, PELITA_SIGN_OUT_HREF, safeAvatarUrl, safeRelativeReturnTo } from "@/lib/return-to";

const seen = vi.hoisted(() => ({
  calls: [] as { path: string; returnTo: string | null; cookie: string | null }[],
}));

const auth0Configured = vi.hoisted(() => vi.fn(() => false));
const getSession = vi.hoisted(() => vi.fn(async () => null as { user?: object } | null));
const middleware = vi.hoisted(() =>
  vi.fn(async (req: NextRequest) => {
    seen.calls.push({
      path: req.nextUrl.pathname,
      returnTo: req.nextUrl.searchParams.get("returnTo"),
      cookie: req.headers.get("cookie"),
    });
    return NextResponse.next();
  }),
);

vi.mock("@/lib/auth0", () => ({
  auth0Configured,
  getAuth0: () => ({ middleware, getSession }),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const ENV_KEYS = [
  "KB_DEMO_TRACK",
  "APPROVAL_SECRET",
  "APP_BASE_URL",
  "APP_URL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "AUTH0_ROLES_CLAIM",
] as const;

function clearEnv() {
  for (const name of ENV_KEYS) delete process.env[name];
  auth0Configured.mockReset().mockReturnValue(false);
  getSession.mockReset().mockResolvedValue(null);
  middleware.mockClear();
  seen.calls.length = 0;
}

const OPEN = ["https://evil.com", "https://evil.com/pelita", "http://x.test/pelita", "//evil.com", "///evil.com", "/\\evil.com", "\\\\evil.com", "javascript:alert(1)", "/%2f%2fevil.com", "/%2F%2Fevil.com", "/%5c%5cevil.com", "/pelita%00", "/pelita%0a", "/%09/evil.com", "", " /pelita", "pelita", "https://x.test/pelita", "/\\tevil.com"] as const;

beforeEach(clearEnv);
afterEach(clearEnv);

describe("returnTo stays on this origin", () => {
  it("accepts a relative path and normalizes dot segments", () => {
    expect(safeRelativeReturnTo("/pelita")).toBe("/pelita");
    expect(safeRelativeReturnTo("/pelita/")).toBe("/pelita/");
    expect(safeRelativeReturnTo("/pelita/ops")).toBe("/pelita/ops");
    expect(safeRelativeReturnTo("/pelita?x=1")).toBe("/pelita?x=1");
    expect(safeRelativeReturnTo("/pelita#top")).toBe("/pelita#top");
    expect(safeRelativeReturnTo("/demo/pelita")).toBe("/demo/pelita");
    expect(safeRelativeReturnTo("/pelita/../pelita")).toBe("/pelita");
  });

  it("refuses absolute, protocol-relative, and encoded off-site values", () => {
    for (const value of OPEN) expect(safeRelativeReturnTo(value), value).toBeNull();
  });

  it("builds the Pelita login and logout links from the relative path", () => {
    expect(PELITA_SIGN_IN_HREF).toBe("/auth/login?returnTo=%2Fpelita");
    expect(PELITA_SIGN_OUT_HREF).toBe("/auth/logout?returnTo=%2Fpelita");
  });

  it("expands logout to the app origin, not the request host", () => {
    expect(absoluteLogoutReturnTo("/pelita", "https://x.test")).toBe("https://x.test/pelita");
    expect(absoluteLogoutReturnTo("/pelita#top", "https://x.test")).toBe("https://x.test/pelita");
    expect(absoluteLogoutReturnTo("https://evil.com", "https://x.test")).toBeNull();
    process.env.APP_BASE_URL = "https://shop.example";
    expect(absoluteLogoutReturnTo("/pelita", "https://evil.test")).toBe("https://shop.example/pelita");
  });

  it("sends every Pelita logout to the allowlisted /pelita URL, not a deeper path or a query", () => {
    process.env.APP_BASE_URL = "https://koffee-bean.vercel.app";
    for (const returnTo of ["/pelita", "/pelita/", "/pelita/yuu", "/pelita?next=1", "/demo/pelita/yuu"]) {
      const logout = prepareAuthReturnTo(
        new NextRequest(`https://preview.vercel.app/auth/logout?returnTo=${encodeURIComponent(returnTo)}`),
      );
      expect(logout).toBeInstanceOf(NextRequest);
      expect((logout as NextRequest).nextUrl.searchParams.get("returnTo"), returnTo).toBe("https://koffee-bean.vercel.app/pelita");
    }
    delete process.env.APP_BASE_URL;
    const account = prepareAuthReturnTo(new NextRequest("https://x.test/auth/logout?returnTo=/account"));
    expect((account as NextRequest).nextUrl.searchParams.get("returnTo")).toBe("https://x.test/account");
  });

  it("keeps only an https avatar with no credentials", () => {
    expect(safeAvatarUrl("https://cdn.example/ada.png")).toBe("https://cdn.example/ada.png");
    expect(safeAvatarUrl("http://cdn.example/ada.png")).toBeUndefined();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeAvatarUrl("//cdn.example/ada.png")).toBeUndefined();
    expect(safeAvatarUrl("https://user:pass@cdn.example/ada.png")).toBeUndefined();
    expect(safeAvatarUrl(null)).toBeUndefined();
  });
});

describe("proxy refuses an open redirect and still gates admin", () => {
  it("rejects an off-site returnTo before login or logout runs", async () => {
    for (const value of ["https://evil.com", "//evil.com", "/\\evil.com", "/%2f%2fevil.com"]) {
      for (const path of ["/auth/login", "/auth/logout"]) {
        const res = await proxy(new NextRequest(`https://x.test${path}?returnTo=${encodeURIComponent(value)}`));
        expect(res.status, `${path} ${value}`).toBe(400);
        expect(await res.text()).toBe("Invalid returnTo.");
      }
    }
    expect(middleware).not.toHaveBeenCalled();
  });

  it("leaves a relative login returnTo relative, and makes logout absolute", async () => {
    const login = prepareAuthReturnTo(new NextRequest("https://x.test/auth/login?returnTo=/pelita"));
    expect(login).toBeInstanceOf(NextRequest);
    expect((login as NextRequest).nextUrl.searchParams.get("returnTo")).toBe("/pelita");

    const logout = prepareAuthReturnTo(
      new NextRequest("https://x.test/auth/logout?returnTo=/pelita", { headers: { cookie: "appSession=abc" } }),
    );
    expect(logout).toBeInstanceOf(NextRequest);
    expect((logout as NextRequest).nextUrl.searchParams.get("returnTo")).toBe("https://x.test/pelita");
    expect((logout as NextRequest).headers.get("cookie")).toBe("appSession=abc");

    auth0Configured.mockReturnValue(true);
    const loginRes = await proxy(new NextRequest("https://x.test/auth/login?returnTo=/pelita", { headers: { cookie: "appSession=abc" } }));
    expect(loginRes.status).toBe(200);
    const logoutRes = await proxy(
      new NextRequest("https://evil.test/auth/logout?returnTo=/pelita", { headers: { cookie: "appSession=abc" } }),
    );
    expect(logoutRes.status).toBe(200);
    process.env.APP_BASE_URL = "https://shop.example";
    await proxy(new NextRequest("https://evil.test/auth/logout?returnTo=/pelita"));
    expect(seen.calls.map((call) => call.returnTo)).toEqual(["/pelita", "https://evil.test/pelita", "https://shop.example/pelita"]);
    expect(seen.calls[0]?.cookie).toBe("appSession=abc");
    expect(seen.calls[1]?.cookie).toBe("appSession=abc");
  });

  it("still answers 503 for a safe returnTo when login is not configured", async () => {
    const res = await proxy(new NextRequest("https://x.test/auth/login?returnTo=/pelita"));
    expect(res.status).toBe(503);
    expect(middleware).not.toHaveBeenCalled();
    const plain = await proxy(new NextRequest("https://x.test/auth/logout"));
    expect(plain.status).toBe(503);
  });

  it("keeps Pelita public and admin surfaces admin-only, signed in or not", async () => {
    auth0Configured.mockReturnValue(true);
    getSession.mockResolvedValue({
      user: { sub: "auth0|ada", email: "ada@example.com", email_verified: true, name: "Ada" },
    });

    expect((await proxy(new NextRequest("https://x.test/pelita"))).status).toBe(404);
    expect(middleware).not.toHaveBeenCalled();
    expect((await proxy(new NextRequest("https://x.test/admin/demo"))).status).toBe(404);

    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = "test-approval-secret";
    expect((await proxy(new NextRequest("https://x.test/pelita"))).status).toBe(200);
    expect((await proxy(new NextRequest("https://x.test/pelita/ops"))).status).toBe(200);
    expect((await proxy(new NextRequest("https://x.test/admin/demo"))).status).toBe(404);
    expect((await proxy(new NextRequest("https://x.test/api/demo/reset"))).status).toBe(404);

    getSession.mockResolvedValue({
      user: {
        sub: "auth0|ada",
        email: "ada@example.com",
        email_verified: true,
        name: "Ada",
        "https://beanbox/roles": ["admin"],
      },
    });
    expect((await proxy(new NextRequest("https://x.test/admin/demo"))).status).toBe(200);
    expect((await proxy(new NextRequest("https://x.test/pelita"))).status).toBe(200);
  });
});

describe("Pelita header uses the existing login", () => {
  const html = (account?: { name?: string; email?: string; picture?: string } | null) =>
    renderToStaticMarkup(createElement(PelitaStorefront, { view: storefrontView(loadScenario()), account }));

  it("points Sign in at login and returns to /pelita", () => {
    const out = html(null);
    expect(out).toContain(`href="${PELITA_SIGN_IN_HREF}"`);
    expect(out).toContain("Sign in");
    expect(out).not.toContain("Sign out");
    expect(out).not.toContain("https://evil.com");
  });

  it("shows the shopper name or email, the avatar, and Sign out", () => {
    const named = html({ name: "Ada Lovelace", email: "ada@example.com", picture: "https://cdn.example/ada.png" });
    expect(named).toContain("Ada Lovelace");
    expect(named).toContain('src="https://cdn.example/ada.png"');
    expect(named).toContain(`href="${PELITA_SIGN_OUT_HREF}"`);
    expect(named).toContain("Sign out");
    expect(named).not.toContain(PELITA_SIGN_IN_HREF);

    const emailOnly = html({ email: "ada@example.com" });
    expect(emailOnly).toContain("ada@example.com");
    expect(emailOnly).not.toContain("<img");

    const blocked = html({ name: "Ada", picture: "javascript:alert(1)" });
    expect(blocked).toContain("Ada");
    expect(blocked).not.toContain("<img");
    expect(blocked).not.toContain("javascript:");
  });
});

describe("the storefront page stays public", () => {
  const root = path.resolve(__dirname, "..");

  async function loadPage() {
    return (await import("@/app/demo/pelita/page")).default;
  }

  it("does not mention the identity provider in the page or the header component", () => {
    for (const file of ["src/app/demo/pelita/page.tsx", "src/components/pelita/PelitaStorefront.tsx"]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text, file).not.toMatch(/auth0|management|process\.env/i);
    }
    const page = readFileSync(path.join(root, "src/app/demo/pelita/page.tsx"), "utf8");
    const gate = page.indexOf("await requirePresenterPage()");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(page.indexOf("signedInAccount()"));
  });

  it("renders signed out when there is no session, and shows the session when there is one", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = "test-approval-secret";
    const Page = await loadPage();

    const signedOut = await Page();
    expect((signedOut as ReactElement).type).toBe(PelitaStorefront);
    expect(renderToStaticMarkup(signedOut as ReactElement)).toContain(PELITA_SIGN_IN_HREF);

    auth0Configured.mockReturnValue(true);
    getSession.mockResolvedValue({
      user: {
        sub: "auth0|ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
        picture: "https://cdn.example/ada.png",
      },
    });
    const shopper = await getShopper();
    expect(shopper).toEqual({
      id: "auth0|ada",
      name: "Ada Lovelace",
      email: "ada@example.com",
      picture: "https://cdn.example/ada.png",
    });
    const signedIn = await Page();
    const html = renderToStaticMarkup(signedIn as ReactElement);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain(PELITA_SIGN_OUT_HREF);
    expect(html).not.toContain(PELITA_SIGN_IN_HREF);

    getSession.mockResolvedValue({
      user: { sub: "auth0|ada", name: "Ada", picture: "javascript:alert(1)" },
    });
    expect((await getShopper())?.picture).toBeUndefined();

    getSession.mockRejectedValue(new Error("session down"));
    const stillPublic = await Page();
    expect((stillPublic as ReactElement).type).toBe(PelitaStorefront);
    expect(renderToStaticMarkup(stillPublic as ReactElement)).toContain(PELITA_SIGN_IN_HREF);
  });
});
