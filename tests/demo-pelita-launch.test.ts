import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { POST as goLiveRoute } from "@/app/api/demo/pelita/ops/go-live/route";
import { GET as getLaunch, POST as postLaunch } from "@/app/api/demo/pelita/launch/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaLaunchSchedule } from "@/components/pelita-ops/PelitaLaunchSchedule";
import { PelitaProductCard } from "@/components/pelita/PelitaProductCard";
import { PelitaProductDetail } from "@/components/pelita/PelitaProductDetail";
import { PelitaProductImage, productArtMode } from "@/components/pelita/PelitaProductImage";
import { PelitaPartnerPurchases } from "@/components/pelita/PelitaPartnerPurchases";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import {
  formatGoLiveSgt,
  isLaunchLive,
  isPromoActive,
  isSafeImageUrl,
  LAUNCH_INDEX_KEY,
  launchPreviewBanner,
  presentPromo,
  productLiveUrl,
  productPreviewUrl,
  targetedLabel,
  toScheduleRow,
  type LaunchConfig,
} from "@/lib/demo/launch";
import { applyLaunchConfigs, applyLaunchesToPartners, resolveProductPage } from "@/lib/demo/launch-view";
import { loadScenario } from "@/lib/demo/scenario";
import { storefrontView } from "@/lib/demo/storefront";
import { partnerOffers } from "@/lib/demo/yuu-partners";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ refresh: () => undefined, push: () => undefined }) };
});

const SECRET = "test-bi-api-secret-0123456789";
const ROOT = path.resolve(__dirname, "..");
const NOW = Date.parse("2026-11-26T01:00:00.000Z");
const FUTURE = "2026-12-01T09:00:00+08:00";
const PAST = "2026-11-01T09:00:00+08:00";
const scenario = loadScenario();

type Command = (string | number)[];

let store: Map<string, string>;
let scanEnabled: boolean;
let now: number;

function execute(commands: Command[]): unknown[] {
  return commands.map((command) => {
    const [name, key, ...rest] = command as [string, string, ...(string | number)[]];
    if (name === "SCAN") {
      if (!scanEnabled) return { error: "unsupported SCAN" };
      const matchAt = command.indexOf("MATCH");
      const pattern = String(command[matchAt + 1] ?? "*");
      const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const keys = [...store.keys()].filter((item) => new RegExp(`^${source}$`).test(item));
      return { result: ["0", keys] };
    }
    if (name === "GET") return { result: store.get(key) ?? null };
    if (name === "SET") {
      store.set(key, String(rest[0]));
      return { result: "OK" };
    }
    if (name === "DEL") return { result: store.delete(key) ? 1 : 0 };
    if (name === "LRANGE") return { result: [] };
    return { error: `unsupported ${name}` };
  });
}

function useRedis() {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(execute(JSON.parse(String(init?.body)) as Command[]))),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = "test-approval-secret";
}

function bearer(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SECRET}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers });
}

function demoPost(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: "https://x.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function launchBody(overrides: Record<string, unknown> = {}) {
  return {
    sku: "PL-20055",
    title: "Night magnesium",
    subtitle: "One capsule before bed",
    longCopy: "A calm evening mineral for the wind-down hour.",
    bullets: ["Take one capsule", "With water"],
    size: "90 capsules",
    category: "Vitamins & supplements",
    supplier: "Northwind Labs",
    imageUrl: "/images/pelita/PL-20055.png",
    shelfPriceCents: 3290,
    promo: {
      type: "pct_off",
      label: "Launch 20% off",
      pctOff: 20,
      startsAt: PAST,
      endsAt: FUTURE,
    },
    memberOffer: {
      memberPriceCents: 2790,
      bonusPoints: 150,
      segmentLabel: "yuu Wellness Repeat Shoppers",
      headline: "Member launch price",
    },
    stores: ["Harbour Mart", "Ridge Pharmacy", "Eastlink Grocery"],
    goLiveAt: FUTURE,
    status: "scheduled",
    ...overrides,
  };
}

async function save(overrides: Record<string, unknown> = {}) {
  const res = await postLaunch(
    bearer("https://x.test/api/demo/pelita/launch", { method: "POST", body: JSON.stringify(launchBody(overrides)) }),
  );
  expect(res.status).toBe(200);
  return res;
}

async function productPage(sku: string, preview = false) {
  const Page = (await import("@/app/demo/pelita/product/[sku]/page")).default;
  return Page({
    params: Promise.resolve({ sku }),
    searchParams: Promise.resolve(preview ? { preview: "1" } : {}),
  });
}

function html(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function partnerCard(markup: string, sku: string): string {
  const start = markup.indexOf(`data-yuu-partner="${sku}"`);
  const next = markup.indexOf("data-yuu-partner=", start + 10);
  return markup.slice(start, next === -1 ? undefined : next);
}

beforeEach(() => {
  store = new Map([
    ["kb:chat:h:user-1", "7"],
    ["kb:demo:pelita:unlisted", "keep"],
  ]);
  scanEnabled = true;
  now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.env.BI_API_SECRET = SECRET;
  useRedis();
  openGate();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BI_API_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KB_DEMO_TRACK;
  delete process.env.APPROVAL_SECRET;
});

describe("launch visibility, promo window, and image urls", () => {
  it("is live only for status live, or a schedule whose go-live instant has arrived", () => {
    expect(isLaunchLive({ status: "draft" }, NOW)).toBe(false);
    expect(isLaunchLive({ status: "draft", goLiveAt: PAST }, NOW)).toBe(false);
    expect(isLaunchLive({ status: "scheduled" }, NOW)).toBe(false);
    expect(isLaunchLive({ status: "scheduled", goLiveAt: FUTURE }, NOW)).toBe(false);
    expect(isLaunchLive({ status: "scheduled", goLiveAt: FUTURE }, Date.parse(FUTURE))).toBe(true);
    expect(isLaunchLive({ status: "scheduled", goLiveAt: PAST }, NOW)).toBe(true);
    expect(isLaunchLive({ status: "live", goLiveAt: FUTURE }, NOW)).toBe(true);
  });

  it("keeps a promo active only inside startsAt and endsAt, including the endpoints", () => {
    const start = Date.parse(PAST);
    const end = Date.parse(FUTURE);
    expect(isPromoActive({ startsAt: PAST, endsAt: FUTURE }, start)).toBe(true);
    expect(isPromoActive({ startsAt: PAST, endsAt: FUTURE }, end)).toBe(true);
    expect(isPromoActive({ startsAt: PAST, endsAt: FUTURE }, start - 1)).toBe(false);
    expect(isPromoActive({ startsAt: PAST, endsAt: FUTURE }, end + 1)).toBe(false);
    expect(isPromoActive({}, NOW)).toBe(true);
    expect(presentPromo({ type: "pct_off", pctOff: 20, startsAt: FUTURE }, 3290, NOW)).toBeNull();
    expect(presentPromo({ type: "pct_off", pctOff: 20, endsAt: PAST }, 3290, NOW)).toBeNull();
    expect(presentPromo({ type: "pct_off", pctOff: 20, startsAt: PAST, endsAt: FUTURE }, 3290, NOW)).toMatchObject({
      type: "pct_off",
      payCents: 2632,
      wasCents: 3290,
      label: "20% off",
    });
    expect(presentPromo({ type: "multibuy", buyQty: 2, bundlePriceCents: 5590, label: "2 for S$55.90" }, 3290, NOW)).toMatchObject({
      type: "multibuy",
      label: "2 for S$55.90",
      payCents: 3290,
      wasCents: null,
    });
    expect(presentPromo({ type: "member_price", memberPriceCents: 2790 }, 3290, NOW)).toMatchObject({
      type: "member_price",
      memberPriceCents: 2790,
      label: "Member price",
    });
  });

  it("formats go-live in Singapore time and refuses unsafe image urls", () => {
    expect(formatGoLiveSgt(FUTURE)).toBe("01 Dec 2026, 09:00 SGT");
    expect(launchPreviewBanner({ status: "draft" }, NOW)).toBe("Draft preview");
    expect(launchPreviewBanner({ status: "scheduled", goLiveAt: FUTURE }, NOW)).toBe("Scheduled to go live 01 Dec 2026, 09:00 SGT");
    expect(launchPreviewBanner({ status: "scheduled", goLiveAt: PAST }, NOW)).toBeNull();
    expect(targetedLabel("yuu Wellness Repeat Shoppers")).toBe("Targeted: yuu Wellness Repeat Shoppers");
    expect(targetedLabel("Targeted: yuu Wellness Repeat Shoppers")).toBe("Targeted: yuu Wellness Repeat Shoppers");
    expect(isSafeImageUrl("/images/pelita/PL-20055.png")).toBe(true);
    expect(isSafeImageUrl("https://cdn.example.com/pack.png")).toBe(true);
    for (const bad of ["javascript:alert(1)", "http://cdn.example.com/a.png", "//cdn.example.com/a.png", "/images/../secret.png", "data:text/html,hi"]) {
      expect(isSafeImageUrl(bad), bad).toBe(false);
    }
    expect(productPreviewUrl("PL-20055")).toBe("/pelita/product/PL-20055?preview=1");
    expect(productLiveUrl("PL-20055")).toBe("/pelita/product/PL-20055");
  });

  it("routes /pelita/product/[sku] through the existing /pelita rewrite", async () => {
    const rules = await nextConfig.rewrites?.();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules).toEqual(
      expect.arrayContaining([
        { source: "/pelita", destination: "/demo/pelita" },
        { source: "/pelita/:path*", destination: "/demo/pelita/:path*" },
      ]),
    );
    expect("/pelita/product/PL-20055".replace(/^\/pelita(?=\/|$)/, "/demo/pelita")).toBe("/demo/pelita/product/PL-20055");
  });
});

describe("POST and GET /api/demo/pelita/launch", () => {
  it("returns 503 when BI_API_SECRET is unset and 401 for a missing or wrong bearer", async () => {
    delete process.env.BI_API_SECRET;
    const closed = await postLaunch(bearer("https://x.test/api/demo/pelita/launch", { method: "POST", body: "{}" }));
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: "unconfigured" });
    expect((await getLaunch(new Request("https://x.test/api/demo/pelita/launch"))).status).toBe(503);

    process.env.BI_API_SECRET = SECRET;
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: SECRET }, { "x-bi-secret": "wrong" }]) {
      const res = await postLaunch(new Request("https://x.test/api/demo/pelita/launch", { method: "POST", headers, body: "{}" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect((await getLaunch(new Request("https://x.test/api/demo/pelita/launch", { headers }))).status).toBe(401);
    }
    expect([...store.keys()].filter((key) => key.startsWith("kb:demo:pelita:launch:"))).toEqual([]);
  });

  it("rejects an invalid body and accepts a scheduled launch with the public urls", async () => {
    const badJson = await postLaunch(bearer("https://x.test/api/demo/pelita/launch", { method: "POST", body: "{" }));
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: "invalid_json" });

    const cases: Record<string, unknown>[] = [
      launchBody({ sku: "" }),
      launchBody({ sku: "bad sku" }),
      launchBody({ sku: "index" }),
      launchBody({ title: "" }),
      launchBody({ shelfPriceCents: 0 }),
      launchBody({ shelfPriceCents: 32.9 }),
      launchBody({ status: "scheduled", goLiveAt: undefined }),
      launchBody({ imageUrl: "javascript:alert(1)" }),
      launchBody({ imageUrl: "http://cdn.example.com/a.png" }),
      launchBody({ imageUrl: "//cdn.example.com/a.png" }),
      launchBody({ promo: { type: "pct_off", startsAt: FUTURE, endsAt: PAST } }),
      launchBody({ status: "nope" }),
    ];
    for (const body of cases) {
      const res = await postLaunch(bearer("https://x.test/api/demo/pelita/launch", { method: "POST", body: JSON.stringify(body) }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_body" });
    }
    expect(store.has(LAUNCH_INDEX_KEY)).toBe(false);

    const created = await save();
    expect(await created.json()).toEqual({
      ok: true,
      sku: "PL-20055",
      status: "scheduled",
      isLive: false,
      goLiveAt: FUTURE,
      previewUrl: "/pelita/product/PL-20055?preview=1",
      liveUrl: "/pelita/product/PL-20055",
    });

    const httpsImage = await save({ sku: "WEB-1", imageUrl: "https://cdn.example.com/pack.png", status: "live", goLiveAt: undefined });
    expect(httpsImage.status).toBe(200);

    const one = await getLaunch(bearer("https://x.test/api/demo/pelita/launch?sku=PL-20055"));
    expect(one.status).toBe(200);
    const payload = (await one.json()) as { ok: boolean; isLive: boolean; config: LaunchConfig; previewUrl: string; liveUrl: string };
    expect(payload.ok).toBe(true);
    expect(payload.isLive).toBe(false);
    expect(payload.previewUrl).toBe("/pelita/product/PL-20055?preview=1");
    expect(payload.liveUrl).toBe("/pelita/product/PL-20055");
    expect(payload.config).toMatchObject({
      sku: "PL-20055",
      title: "Night magnesium",
      shelfPriceCents: 3290,
      imageUrl: "/images/pelita/PL-20055.png",
      status: "scheduled",
      bullets: ["Take one capsule", "With water"],
      memberOffer: { memberPriceCents: 2790, bonusPoints: 150, segmentLabel: "yuu Wellness Repeat Shoppers" },
    });

    const list = await getLaunch(bearer("https://x.test/api/demo/pelita/launch"));
    const listed = (await list.json()) as { launches: { sku: string }[] };
    expect(listed.launches.map((row) => row.sku)).toEqual(["PL-20055", "WEB-1"]);

    expect((await getLaunch(bearer("https://x.test/api/demo/pelita/launch?sku=MISSING"))).status).toBe(404);
    expect((await getLaunch(bearer("https://x.test/api/demo/pelita/launch?sku=bad sku"))).status).toBe(400);

    const past = await save({ sku: "PAST-1", status: "scheduled", goLiveAt: PAST });
    expect(await past.json()).toMatchObject({ status: "scheduled", isLive: true });
    const draft = await save({ sku: "DRAFT-1", status: "draft", goLiveAt: PAST });
    expect(await draft.json()).toMatchObject({ status: "draft", isLive: false, goLiveAt: PAST });
    const forced = await save({ sku: "LIVE-1", status: "live", goLiveAt: FUTURE });
    expect(await forced.json()).toMatchObject({ status: "live", isLive: true });
  });

  it("returns 503 when redis is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const res = await postLaunch(bearer("https://x.test/api/demo/pelita/launch", { method: "POST", body: JSON.stringify(launchBody({ status: "live" })) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "store_unavailable" });
    expect((await getLaunch(bearer("https://x.test/api/demo/pelita/launch"))).status).toBe(503);
  });
});

describe("shelf visibility and reset", () => {
  it("hides a future schedule from the shop, previews it, and shows it once the time arrives", async () => {
    await save();
    await expect(productPage("PL-20055")).rejects.toMatchObject({ digest: expect.stringContaining("404") });

    const preview = html(await productPage("PL-20055", true));
    expect(preview).toContain('data-pdp-state="preview"');
    expect(preview).toContain("Scheduled to go live 01 Dec 2026, 09:00 SGT");
    expect(preview).toContain("Night magnesium");
    expect(preview).toContain("data-long-copy");
    expect(preview).toContain("Take one capsule");
    expect(preview).toContain("Northwind Labs");
    expect(preview).toContain('data-promo="pct_off"');
    expect(preview).toContain("S$26.32");
    expect(preview).toContain("S$32.90");
    expect(preview).toContain("Member S$27.90");
    expect(preview).toContain("150 bonus points");
    expect(preview).toContain("Targeted: yuu Wellness Repeat Shoppers");
    expect(preview).toContain('data-store="Harbour Mart"');
    expect(preview).toContain('src="/images/pelita/PL-20055.png"');
    expect(preview).toContain("Add to bag");

    const Page = (await import("@/app/demo/pelita/page")).default;
    const before = html(await Page());
    expect(before).not.toContain("Night magnesium");
    expect(before).not.toContain('data-product-id="PL-20055"');

    const Yuu = (await import("@/app/demo/pelita/yuu/page")).default;
    const yuuBefore = html(await Yuu());
    expect(partnerCard(yuuBefore, "PL-20055")).toContain("Not at Pelita");
    expect(partnerCard(yuuBefore, "PL-20055")).not.toContain("Also at Pelita");

    now = Date.parse(FUTURE);
    const live = html(await productPage("PL-20055"));
    expect(live).toContain('data-pdp-state="live"');
    expect(live).not.toContain("data-preview-banner");
    expect(html(await Page())).toContain("Night magnesium");
    expect(html(await Page())).toContain('href="/pelita/product/PL-20055"');
    const yuuAfter = html(await Yuu());
    expect(partnerCard(yuuAfter, "PL-20055")).toContain("Also at Pelita");
  });

  it("keeps the catalogue and the listed flag working when no launch config exists", async () => {
    const vit = scenario.catalogue.find((item) => item.id === "PL-10011")!;
    const shown = html(await productPage(vit.id));
    expect(shown).toContain(vit.name);
    expect(shown).toContain(`data-sku="${vit.id}"`);
    expect(shown).toContain("Add to bag");
    await expect(productPage("PL-20055")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    await expect(productPage("PL-20055", true)).rejects.toMatchObject({ digest: expect.stringContaining("404") });

    store.set("kb:demo:pelita:listed", "1");
    const listed = html(await productPage("PL-20055"));
    expect(listed).toContain(scenario.catalogue.find((item) => item.id === "PL-20055")!.name);
    expect(listed).not.toContain("data-preview-banner");

    const hidden = resolveProductPage({ sku: "PL-20055", scenario, listed: false, config: null, preview: true, now: NOW });
    expect(hidden.hidden).toBe(true);
    expect(applyLaunchConfigs(storefrontView(scenario, { listed: true }), scenario, [])).toEqual(storefrontView(scenario, { listed: true }));
  });

  it("drops an expired promo and a draft preview banner", async () => {
    await save({ promo: { type: "pct_off", pctOff: 20, endsAt: PAST }, status: "live", goLiveAt: undefined });
    const expired = html(await productPage("PL-20055"));
    expect(expired).not.toContain("data-promo");
    expect(expired).toContain("S$32.90");
    expect(expired).not.toContain("S$26.32");

    await save({ sku: "DRAFT-9", status: "draft", goLiveAt: undefined, promo: undefined, memberOffer: undefined });
    await expect(productPage("DRAFT-9")).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect(html(await productPage("DRAFT-9", true))).toContain("Draft preview");
  });

  it("clears launch keys on reset, including keys missing from the index, and leaves foreign keys", async () => {
    await save();
    store.set("kb:demo:pelita:launch:ORPHAN", "{\"sku\":\"ORPHAN\"}");
    store.set("kb:demo:pelita:stage", "4");
    expect(store.has(LAUNCH_INDEX_KEY)).toBe(true);

    const res = await resetRoute(demoPost("https://x.test/api/demo/pelita/reset"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 0, listed: false, approvals: {}, audit: [] });
    expect(store.has("kb:demo:pelita:launch:PL-20055")).toBe(false);
    expect(store.has("kb:demo:pelita:launch:ORPHAN")).toBe(false);
    expect(store.has(LAUNCH_INDEX_KEY)).toBe(false);
    expect(store.get("kb:chat:h:user-1")).toBe("7");
    expect(store.get("kb:demo:pelita:unlisted")).toBe("keep");
    expect(store.get("kb:demo:pelita:stage")).toBe("0");
    expect(store.get("kb:demo:pelita:listed")).toBe("0");

    const list = await getLaunch(bearer("https://x.test/api/demo/pelita/launch"));
    expect(await list.json()).toEqual({ ok: true, launches: [] });
  });

  it("still deletes indexed launch keys when SCAN is unavailable", async () => {
    await save({ status: "live" });
    scanEnabled = false;
    const res = await resetRoute(demoPost("https://x.test/api/demo/pelita/reset"));
    expect(res.status).toBe(200);
    expect(store.has("kb:demo:pelita:launch:PL-20055")).toBe(false);
    expect(store.has(LAUNCH_INDEX_KEY)).toBe(false);
    expect(store.get("kb:chat:h:user-1")).toBe("7");
  });
});

describe("ops go live now", () => {
  it("publishes a scheduled sku without the BI secret and the ops panel links to preview and live", async () => {
    await save();
    delete process.env.KB_DEMO_TRACK;
    expect((await goLiveRoute(demoPost("https://x.test/api/demo/pelita/ops/go-live", { sku: "PL-20055" }))).status).toBe(404);
    openGate();
    expect((await goLiveRoute(new Request("https://x.test/api/demo/pelita/ops/go-live", { method: "POST", body: JSON.stringify({ sku: "PL-20055" }) }))).status).toBe(403);
    expect((await goLiveRoute(demoPost("https://x.test/api/demo/pelita/ops/go-live", { sku: "bad sku" }))).status).toBe(400);
    expect((await goLiveRoute(demoPost("https://x.test/api/demo/pelita/ops/go-live", { sku: "NOPE" }))).status).toBe(404);

    const row = toScheduleRow((await (await getLaunch(bearer("https://x.test/api/demo/pelita/launch?sku=PL-20055"))).json() as { config: LaunchConfig }).config, NOW);
    const waiting = html(createElement(PelitaLaunchSchedule, { rows: [row] }));
    expect(waiting).toContain("Launch Schedule &amp; Configs");
    expect(waiting).toContain("scheduled");
    expect(waiting).toContain("Not live yet");
    expect(waiting).toContain("01 Dec 2026, 09:00 SGT");
    expect(waiting).toContain('href="/pelita/product/PL-20055?preview=1"');
    expect(waiting).not.toMatch(/href="\/pelita\/product\/PL-20055"/);
    expect(waiting).toContain("Go live now");
    expect(waiting).toContain('data-go-live="PL-20055"');

    const published = await goLiveRoute(demoPost("https://x.test/api/demo/pelita/ops/go-live", { sku: "PL-20055" }));
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({
      ok: true,
      sku: "PL-20055",
      status: "live",
      isLive: true,
      goLiveAt: FUTURE,
      previewUrl: "/pelita/product/PL-20055?preview=1",
      liveUrl: "/pelita/product/PL-20055",
    });
    expect((await goLiveRoute(demoPost("https://x.test/api/demo/pelita/ops/go-live", { sku: "PL-20055" }))).status).toBe(200);

    const livePage = html(await productPage("PL-20055"));
    expect(livePage).toContain('data-pdp-state="live"');
    expect(livePage).not.toContain("Scheduled to go live");

    const liveRow = toScheduleRow((await (await getLaunch(bearer("https://x.test/api/demo/pelita/launch?sku=PL-20055"))).json() as { config: LaunchConfig }).config, NOW);
    const done = html(createElement(PelitaLaunchSchedule, { rows: [liveRow] }));
    expect(done).toContain("Live now");
    expect(done).toMatch(/href="\/pelita\/product\/PL-20055"/);
    expect(done).not.toContain("Go live now");

    expect(readFileSync(path.join(ROOT, "src/app/api/demo/pelita/ops/go-live/route.ts"), "utf8")).not.toMatch(/BI_API_SECRET/);
    expect(readFileSync(path.join(ROOT, "src/app/api/demo/pelita/ops/go-live/route.ts"), "utf8")).toMatch(/guardDemoWrite\(req\)/);
    expect(readFileSync(path.join(ROOT, "src/app/api/demo/pelita/launch/route.ts"), "utf8")).toMatch(/requireBiSecret\(req\)/);
    expect(readFileSync(path.join(ROOT, "src/lib/demo/launch-client.ts"), "utf8")).toContain("/api/demo/pelita/ops/go-live");
    expect(readFileSync(path.join(ROOT, "src/app/api/demo/pelita/reset/route.ts"), "utf8")).toMatch(/clearLaunchConfigs\(\)/);
  });
});

describe("product card, image fallback, and targeted offer", () => {
  it("links shelf cards to the PDP and falls back from a real image to the kit SVG", () => {
    const card = storefrontView(scenario).deals.products[0]!;
    const shelf = html(createElement(PelitaProductCard, { product: card, onAdd: () => undefined }));
    expect(shelf).toContain(`href="/pelita/product/${card.id}"`);
    expect(shelf).toContain("data-product-art");
    expect(shelf).not.toContain("data-product-image");

    const shot = html(createElement(PelitaProductImage, { imageUrl: "/images/pelita/PL-20055.png", art: "magnesium", alt: "Magnesium" }));
    expect(shot).toContain('data-product-image=""');
    expect(shot).toContain('src="/images/pelita/PL-20055.png"');
    expect(shot).not.toContain("<svg");

    const broken = html(createElement(PelitaProductImage, { imageUrl: "/images/pelita/PL-20055.png", art: "magnesium", alt: "", failed: true }));
    expect(broken).toContain("data-product-art");
    expect(broken).toContain("<svg");
    expect(broken).not.toContain("data-product-image");
    expect(productArtMode("/images/pelita/PL-20055.png", false)).toBe("image");
    expect(productArtMode("/images/pelita/PL-20055.png", true)).toBe("svg");
    expect(productArtMode(null, false)).toBe("svg");
    expect(productArtMode(undefined, false)).toBe("svg");

    const offer = resolveProductPage({
      sku: "NEW-77",
      scenario,
      listed: false,
      preview: false,
      now: NOW,
      config: {
        sku: "NEW-77",
        title: "Evening magnesium",
        shelfPriceCents: 3290,
        status: "live",
        imageUrl: "/images/pelita/PL-20055.png",
        memberOffer: { memberPriceCents: 2790, bonusPoints: 40, segmentLabel: "yuu Wellness Repeat Shoppers" },
        stores: ["Harbour Mart"],
      },
    });
    expect(offer.hidden).toBe(false);
    if (offer.hidden) return;
    const detail = html(createElement(PelitaProductDetail, { product: offer.product, wordmark: scenario.brand.wordmark, yuuSignInHref: "/auth/login?returnTo=%2Fpelita" }));
    expect(detail).toContain("Evening magnesium");
    expect(detail).toContain('src="/images/pelita/PL-20055.png"');
    expect(detail).toContain("Targeted: yuu Wellness Repeat Shoppers");
    expect(detail).toContain("40 bonus points");
    expect(detail).toContain("Member S$27.90");
    expect(detail).toContain('data-store="Harbour Mart"');
    expect(detail).toContain("Add to bag");

    const deals = storefrontView(scenario);
    const hiddenDeals = applyLaunchConfigs(deals, scenario, [{ sku: deals.deals.products[0]!.id, title: "Hidden deal", shelfPriceCents: 100, status: "scheduled", goLiveAt: FUTURE }], NOW);
    expect(hiddenDeals.catalogue.map((item) => item.id)).not.toContain(deals.deals.products[0]!.id);
    expect(hiddenDeals.deals.products.map((item) => item.id)).not.toContain(deals.deals.products[0]!.id);

    const added = applyLaunchConfigs(deals, scenario, [{ sku: "NEW-77", title: "Evening magnesium", shelfPriceCents: 3290, status: "live", imageUrl: "/images/pelita/PL-20055.png" }], NOW);
    expect(added.deals.products[0]).toMatchObject({ id: "NEW-77", imageUrl: "/images/pelita/PL-20055.png", highlight: true });
    const withImage = html(createElement(PelitaStorefront, { view: added }));
    expect(withImage).toContain('src="/images/pelita/PL-20055.png"');
    expect(withImage).toContain('href="/pelita/product/NEW-77"');

    const partners = applyLaunchesToPartners(partnerOffers(scenario, true), scenario, [{ sku: "PL-20055", title: "Night magnesium", shelfPriceCents: 3290, status: "scheduled", goLiveAt: FUTURE, imageUrl: "/images/pelita/PL-20055.png" }], NOW);
    expect(partners.find((item) => item.id === "PL-20055")).toMatchObject({ atPelita: false, imageUrl: "/images/pelita/PL-20055.png" });
    const partnerHtml = html(
      createElement(PelitaPartnerPurchases, {
        offers: partners,
        account: null,
        signInHref: "/auth/login?returnTo=%2Fpelita%2Fyuu",
        wordmark: scenario.brand.wordmark,
      }),
    );
    expect(partnerHtml).toContain('src="/images/pelita/PL-20055.png"');
    expect(partnerHtml).toContain("Not at Pelita");
  });
});
