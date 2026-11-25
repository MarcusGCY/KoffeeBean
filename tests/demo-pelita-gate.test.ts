import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { GET as enter } from "@/app/demo/pelita/enter/route";
import { GET as readState } from "@/app/api/demo/pelita/state/route";
import { POST as reset } from "@/app/api/demo/pelita/reset/route";
import { demoEnabled, guardDemoApi, guardDemoWrite } from "@/lib/demo/guard";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { demoTrack } from "@/lib/demo/track";

const SECRET = "test-approval-secret";
const ENV_KEYS = [
  "KB_DEMO_TRACK",
  "VERCEL_ENV",
  "APPROVAL_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APP_BASE_URL",
] as const;

function clearEnv() {
  for (const name of ENV_KEYS) delete process.env[name];
}

function withCookie(url: string, token: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", `${PRESENTER_COOKIE}=${token}`);
  return new Request(url, { ...init, headers });
}

describe("demo track gate", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("is off when KB_DEMO_TRACK is unset or anything but pelita", () => {
    expect(demoTrack()).toBeNull();
    for (const value of ["", "Pelita", "PELITA", "true", "1", "pelita "]) {
      process.env.KB_DEMO_TRACK = value;
      expect(demoTrack()).toBeNull();
    }
  });

  it("is on only for KB_DEMO_TRACK=pelita", () => {
    process.env.KB_DEMO_TRACK = "pelita";
    expect(demoTrack()).toBe("pelita");
    process.env.VERCEL_ENV = "preview";
    expect(demoTrack()).toBe("pelita");
    process.env.VERCEL_ENV = "development";
    expect(demoTrack()).toBe("pelita");
  });

  it("refuses on Vercel production even when the flag is set", () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.VERCEL_ENV = "production";
    expect(demoTrack()).toBeNull();
    process.env.APPROVAL_SECRET = SECRET;
    expect(demoEnabled()).toBe(false);
    const token = signPresenterToken(SECRET);
    expect(guardDemoApi(withCookie("https://x.test/api/demo/pelita/state", token))?.status).toBe(404);
  });

  it("answers 404 without a secret, without a cookie, and with a bad cookie", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    const token = signPresenterToken(SECRET);
    const url = "https://x.test/api/demo/pelita/state";

    expect(demoEnabled()).toBe(false);
    expect(guardDemoApi(withCookie(url, token))?.status).toBe(404);

    process.env.APPROVAL_SECRET = SECRET;
    expect(demoEnabled()).toBe(true);
    expect(guardDemoApi(new Request(url))?.status).toBe(404);
    expect(guardDemoApi(withCookie(url, `${token}0`))?.status).toBe(404);
    expect(guardDemoApi(withCookie(url, token))).toBeNull();
    expect((await readState(new Request(url)) as Response).status).toBe(404);
  });

  it("404s every demo route when the gate is off, even with a valid token", async () => {
    process.env.APPROVAL_SECRET = SECRET;
    const token = signPresenterToken(SECRET);
    expect((await enter(new Request(`https://x.test/demo/pelita/enter?k=${token}`))).status).toBe(404);
    expect((await readState(withCookie("https://x.test/api/demo/pelita/state", token))).status).toBe(404);
    const post = withCookie("https://x.test/api/demo/pelita/reset", token, {
      method: "POST",
      headers: { origin: "https://x.test" },
    });
    expect((await reset(post)).status).toBe(404);
  });

  it("enter sets an httpOnly cookie for a valid link and redirects without the token", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    const token = signPresenterToken(SECRET);
    const res = await enter(new Request(`https://x.test/demo/pelita/enter?k=${token}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://x.test/demo/pelita");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${PRESENTER_COOKIE}=${token}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("secure");

    const bad = await enter(new Request(`https://x.test/demo/pelita/enter?k=${token}x`));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect((await enter(new Request("https://x.test/demo/pelita/enter"))).status).toBe(404);
  });

  it("reset refuses cross-site requests and reports an unconfigured store as 503", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    const token = signPresenterToken(SECRET);
    const url = "https://x.test/api/demo/pelita/reset";

    const cross = withCookie(url, token, { method: "POST", headers: { origin: "https://evil.test" } });
    expect(guardDemoWrite(cross)?.status).toBe(403);
    expect((await reset(cross)).status).toBe(403);

    const same = withCookie(url, token, { method: "POST", headers: { origin: "https://x.test" } });
    expect(guardDemoWrite(same)).toBeNull();
    expect((await reset(same)).status).toBe(503);
    expect((await readState(withCookie("https://x.test/api/demo/pelita/state", token))).status).toBe(503);
  });
});

describe("proxy and the demo API", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("lets /api/demo/pelita through to its own gate, and keeps other /api/demo paths owner-only", async () => {
    const pelita = await proxy(new NextRequest("https://x.test/api/demo/pelita/state"));
    expect(pelita.status).toBe(200);
    for (const path of ["/api/demo/reset", "/api/demo/bi-seed", "/admin/demo"]) {
      const res = await proxy(new NextRequest(`https://x.test${path}`));
      expect(res.status, path).toBe(404);
    }
  });

  it("answers a real 404 for /demo/pelita pages unless the gate is open and the cookie is valid", async () => {
    const page = (cookie?: string) =>
      proxy(new NextRequest("https://x.test/demo/pelita", cookie ? { headers: { cookie } } : undefined));
    const token = signPresenterToken(SECRET);

    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
    expect((await proxy(new NextRequest(`https://x.test/demo/pelita/enter?k=${token}`))).status).toBe(404);

    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}x`)).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(200);
    expect((await proxy(new NextRequest(`https://x.test/demo/pelita/enter?k=${token}`))).status).toBe(200);

    process.env.VERCEL_ENV = "production";
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
  });
});
