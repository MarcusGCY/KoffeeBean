import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getCart } from "@/app/api/cart/route";
import { POST as placeOrder, GET as listOrders } from "@/app/api/orders/route";
import { POST as githubWebhook } from "@/app/api/github/webhook/route";
import { POST as privacyPurge } from "@/app/api/privacy/purge/route";
import { POST as privacyReconcile } from "@/app/api/privacy/reconcile-marketing/route";
import { POST as triageClassify } from "@/app/api/triage/classify/route";
import { proxy } from "@/proxy";
import { GET as enter } from "@/app/demo/pelita/enter/route";
import { GET as readState } from "@/app/api/demo/pelita/state/route";
import { POST as reset } from "@/app/api/demo/pelita/reset/route";
import { findCoupon } from "@/lib/coupons";
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

  it("is on only for KB_DEMO_TRACK=pelita, including production", () => {
    process.env.KB_DEMO_TRACK = "pelita";
    expect(demoTrack()).toBe("pelita");
    process.env.VERCEL_ENV = "preview";
    expect(demoTrack()).toBe("pelita");
    process.env.VERCEL_ENV = "development";
    expect(demoTrack()).toBe("pelita");
    process.env.VERCEL_ENV = "production";
    expect(demoTrack()).toBe("pelita");
  });

  it("stays off on Vercel production unless KB_DEMO_TRACK is exactly pelita, and then stays presenter-gated", () => {
    process.env.VERCEL_ENV = "production";
    expect(demoTrack()).toBeNull();
    expect(demoEnabled()).toBe(false);
    for (const value of ["", "Pelita", "PELITA", "true", "1", "pelita "]) {
      process.env.KB_DEMO_TRACK = value;
      expect(demoTrack()).toBeNull();
      expect(demoEnabled()).toBe(false);
    }

    process.env.KB_DEMO_TRACK = "pelita";
    expect(demoTrack()).toBe("pelita");
    expect(demoEnabled()).toBe(false);
    const token = signPresenterToken(SECRET);
    const url = "https://x.test/api/demo/pelita/state";
    expect(guardDemoApi(withCookie(url, token))?.status).toBe(404);

    process.env.APPROVAL_SECRET = SECRET;
    expect(demoEnabled()).toBe(true);
    expect(guardDemoApi(new Request(url))?.status).toBe(404);
    expect(guardDemoApi(withCookie(url, `${token}0`))?.status).toBe(404);
    expect(guardDemoApi(withCookie(url, token))).toBeNull();
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
    delete process.env.KB_DEMO_TRACK;
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
    expect((await proxy(new NextRequest(`https://x.test/demo/pelita/enter?k=${token}`))).status).toBe(404);
    process.env.KB_DEMO_TRACK = "pelita";
    expect((await page()).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}x`)).status).toBe(404);
    expect((await page(`${PRESENTER_COOKIE}=${token}`)).status).toBe(200);
    expect((await proxy(new NextRequest(`https://x.test/demo/pelita/enter?k=${token}`))).status).toBe(200);
  });
});

const ROOT = path.resolve(__dirname, "..");
const SHOP_PATHS = [
  "/",
  "/api/cart",
  "/api/cart/items",
  "/api/cart/coupon",
  "/api/orders",
  "/api/orders/BB-1001",
  "/api/orders/BB-1001/cancel",
  "/api/github/webhook",
  "/api/triage/classify",
  "/api/privacy/purge",
  "/api/privacy/reconcile-marketing",
  "/api/feedback",
  "/api/chat",
  "/api/fix-status",
  "/api/merge",
  "/api/review",
  "/api/products/view",
] as const;
const SHOP_SECRET_KEYS = ["GITHUB_WEBHOOK_SECRET", "TRIAGE_API_SECRET", "PRIVACY_MAINTENANCE_SECRET", "XAI_API_KEY"] as const;

function sourceFiles(rel: string): string[] {
  const dir = path.join(ROOT, rel);
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const child = path.join(rel, name);
    return statSync(full).isDirectory() ? sourceFiles(child) : [child];
  });
}

async function responseText(run: () => Promise<Response>): Promise<string> {
  try {
    const res = await run();
    return `${res.status}\n${await res.text()}`;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `throw\n${message}`;
  }
}

describe("the real shop stays unchanged when the demo track is off or pelita", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("reads KB_DEMO_TRACK only in demoTrack, so shop, cart, orders, GitHub, triage and privacy cannot branch on it", () => {
    const readers = sourceFiles("src")
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .filter((file) => readFileSync(path.join(ROOT, file), "utf8").includes("KB_DEMO_TRACK"));
    expect(readers).toEqual(["src/lib/demo/track.ts"]);
    const proxySource = readFileSync(path.join(ROOT, "src/proxy.ts"), "utf8");
    expect(proxySource).toContain('pathname.startsWith("/api/demo/pelita/")');
    expect(proxySource).not.toMatch(/\/api\/(github|triage|privacy)/);
  });

  it("passes the storefront, cart, orders and prod API routes through on production with the flag unset and set", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.APPROVAL_SECRET = SECRET;
    const token = signPresenterToken(SECRET);
    const cookie = `${PRESENTER_COOKIE}=${token}`;
    const statuses = async () => {
      const out: Record<string, number> = {};
      for (const shopPath of SHOP_PATHS) {
        const method = shopPath === "/" ? "GET" : "POST";
        const res = await proxy(new NextRequest(`https://x.test${shopPath}`, { method, headers: { cookie } }));
        out[shopPath] = res.status;
      }
      for (const ownerPath of ["/api/demo/reset", "/api/demo/bi-seed", "/admin/demo"]) {
        out[ownerPath] = (await proxy(new NextRequest(`https://x.test${ownerPath}`, { headers: { cookie } }))).status;
      }
      return out;
    };

    const off = await statuses();
    process.env.KB_DEMO_TRACK = "pelita";
    expect(await statuses()).toEqual(off);
    for (const shopPath of SHOP_PATHS) expect(off[shopPath], shopPath).toBe(200);
    expect(off["/api/demo/reset"]).toBe(404);
    expect(off["/admin/demo"]).toBe(404);
    expect(findCoupon("WELCOME10")?.percentOff).toBe(10);
    delete process.env.KB_DEMO_TRACK;
    expect(findCoupon("WELCOME10")?.percentOff).toBe(10);
  });

  it("answers cart, orders, GitHub, triage and privacy the same way on production with the flag unset and set", async () => {
    const saved = Object.fromEntries(SHOP_SECRET_KEYS.map((name) => [name, process.env[name]])) as Record<string, string | undefined>;
    for (const name of SHOP_SECRET_KEYS) delete process.env[name];
    try {
      process.env.VERCEL_ENV = "production";
      const orderReq = () =>
        new Request("https://x.test/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://x.test" },
          body: "{}",
        });
      const call = async () => ({
        cart: await responseText(() => getCart()),
        orders: await responseText(() => listOrders()),
        checkout: await responseText(() => placeOrder(orderReq())),
        github: await responseText(() => githubWebhook(new Request("https://x.test/api/github/webhook", { method: "POST", body: "{}" }))),
        triage: await responseText(() => triageClassify(new Request("https://x.test/api/triage/classify", { method: "POST", body: "{}" }))),
        purge: await responseText(() => privacyPurge(new Request("https://x.test/api/privacy/purge", { method: "POST", body: "{}" }))),
        reconcile: await responseText(() => privacyReconcile(new Request("https://x.test/api/privacy/reconcile-marketing", { method: "POST" }))),
      });

      const off = await call();
      process.env.KB_DEMO_TRACK = "pelita";
      process.env.APPROVAL_SECRET = SECRET;
      const on = await call();
      expect(on).toEqual(off);
      for (const [name, text] of Object.entries(on)) {
        expect(text.startsWith("404"), name).toBe(false);
        expect(text, name).not.toContain("Not found");
      }
      expect(on.github.startsWith("503")).toBe(true);
      expect(on.triage.startsWith("503")).toBe(true);
      expect(on.purge.startsWith("503")).toBe(true);
      expect(on.reconcile.startsWith("503")).toBe(true);
    } finally {
      for (const name of SHOP_SECRET_KEYS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});
