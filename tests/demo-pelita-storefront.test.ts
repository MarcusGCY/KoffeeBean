import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "@/data/demo-scenario.json";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { demandGapView } from "@/lib/demo/demand-gap";
import { opsConsoleView } from "@/lib/demo/ops-console";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";
import { formatSgd, searchCatalogue, splitCountdown, storefrontView } from "@/lib/demo/storefront";

const cookieJar: { value: string | undefined } = { value: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.value && name === PRESENTER_COOKIE ? { name, value: cookieJar.value } : undefined),
  }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

const SECRET = "test-approval-secret";
const ENV_KEYS = ["KB_DEMO_TRACK", "VERCEL_ENV", "APPROVAL_SECRET"] as const;
const ROOT = path.resolve(__dirname, "..");

function clearEnv() {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function sourceFiles(rel: string): string[] {
  const dir = path.join(ROOT, rel);
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const child = path.join(rel, name);
    return statSync(full).isDirectory() ? sourceFiles(child) : [child];
  });
}

function renderStorefront(scenario = loadScenario()): string {
  return renderToStaticMarkup(createElement(PelitaStorefront, { view: storefrontView(scenario) }));
}

function editedScenario(edit: (draft: typeof raw) => void) {
  const draft = structuredClone(raw);
  edit(draft);
  return parseScenario(draft);
}

describe("/demo/pelita page respects the gate", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  async function loadPage() {
    const mod = await import("@/app/demo/pelita/page");
    return mod.default;
  }

  it("is a 404 when the track flag is off, even with a valid presenter cookie", async () => {
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    const Page = await loadPage();
    await expect(Page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("is a 404 on Vercel production even with the flag and a valid cookie", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.VERCEL_ENV = "production";
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    const Page = await loadPage();
    await expect(Page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("is a 404 without a cookie or with a forged one", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    const Page = await loadPage();
    await expect(Page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    cookieJar.value = `${signPresenterToken(SECRET)}0`;
    await expect(Page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    cookieJar.value = signPresenterToken("some-other-secret");
    await expect(Page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
  });

  it("renders the storefront from the fixture for a presenter", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    const Page = await loadPage();
    const element = await Page();
    expect(isValidElement(element)).toBe(true);
    const { type, props } = element as ReactElement<{ view: ReturnType<typeof storefrontView> }>;
    expect(type).toBe(PelitaStorefront);
    expect(props.view).toEqual(storefrontView(loadScenario()));
  });

  it("is refused by the proxy before the page runs when the gate is closed", async () => {
    const closed = await proxy(new NextRequest("https://x.test/demo/pelita"));
    expect(closed.status).toBe(404);
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    const noCookie = await proxy(new NextRequest("https://x.test/demo/pelita"));
    expect(noCookie.status).toBe(404);
    const token = signPresenterToken(SECRET);
    const open = await proxy(
      new NextRequest("https://x.test/demo/pelita", { headers: { cookie: `${PRESENTER_COOKIE}=${token}` } }),
    );
    expect(open.status).toBe(200);
  });
});

describe("storefront renders the catalogue from the fixture", () => {
  const scenario = loadScenario();
  const html = renderStorefront();

  it("shows the five deals of the week with their fixture prices, ribbons and stock", () => {
    for (const id of scenario.storefront.dealsOfTheWeek.productIds) {
      const item = scenario.catalogue.find((p) => p.id === id)!;
      expect(html, id).toContain(`data-product-id="${id}"`);
      expect(html).toContain(item.name.replace(/&/g, "&amp;"));
      expect(html).toContain(formatSgd(item.salePrice ?? item.price));
      if (item.promo) expect(html).toContain(item.promo.ribbon);
    }
    expect(html.match(/data-product-id=/g)).toHaveLength(5);
    expect(html).toContain("S$19.90");
    expect(html).toContain("Member S$13.50");
    expect(html).toContain("Low stock · 4 left");
    expect(html).toContain("Out of stock");
    expect(html).toContain("Bestseller");
  });

  it("takes its chrome copy from the fixture", () => {
    expect(html).toContain(scenario.brand.wordmark);
    expect(html).toContain(scenario.brand.wordmarkSub.replace(/&/g, "&amp;"));
    expect(html).toContain(scenario.storefront.hero.headline);
    expect(html).toContain(scenario.storefront.sideBanner.headline);
    expect(html).toContain(scenario.storefront.searchPlaceholder);
    for (const category of scenario.storefront.categories) expect(html).toContain(category.replace(/&/g, "&amp;"));
    for (const line of [...scenario.storefront.utilityBar.left, ...scenario.storefront.utilityBar.right]) {
      expect(html).toContain(line);
    }
    expect(html).toContain("<b");
    expect(splitCountdown(scenario.storefront.dealsOfTheWeek.countdown)).toEqual({
      prefix: "Ends in",
      parts: ["2d", "06h", "14m"],
    });
  });

  it("carries a visible DEMO DATA tag and a client-side cart that starts at S$0.00", () => {
    expect(html).toMatch(/<span data-demo-tag="[^"]*"[^>]*>DEMO DATA<\/span>/);
    expect(html).toContain("S$0.00");
    expect(html).not.toContain("data-cart-count");
  });

  it("follows fixture edits, so numbers are changed in one place", () => {
    const edited = editedScenario((draft) => {
      const vitC = draft.catalogue.find((p) => p.id === "PL-20013")!;
      vitC.name = "Vitamin C 500 mg";
      vitC.salePrice = 12.34;
      draft.storefront.hero.headline = "Up to 30% off vitamins";
      draft.demoTag = "DEMO DATA" as const;
    });
    const out = renderStorefront(edited);
    expect(out).toContain("Vitamin C 500 mg");
    expect(out).toContain("S$12.34");
    expect(out).toContain("Up to 30% off vitamins");
    expect(out).not.toContain("Vitamin C 1000 mg");
  });

  it("never lists the product that is not launched yet, and search finds nothing for it", () => {
    const view = storefrontView(scenario);
    expect(view.catalogue).toHaveLength(19);
    expect(view.catalogue.map((p) => p.id)).not.toContain("PL-20055");
    expect(html).not.toContain("Magnesium");
    expect(searchCatalogue(view.catalogue, "magnesium glycinate")).toEqual([]);
    expect(searchCatalogue(view.catalogue, "VITAMIN c 1000").map((p) => p.id)).toEqual(["PL-20013"]);
    expect(searchCatalogue(view.catalogue, "  ")).toHaveLength(19);
  });

  it("only uses art that exists in the kit and never references real customer data or write paths", () => {
    for (const item of scenario.catalogue) expect(Object.keys(PELITA_ART)).toContain(item.art);
    const files = [
      ...sourceFiles("src/components/pelita"),
      "src/app/demo/pelita/page.tsx",
      "src/lib/demo/storefront.ts",
      "src/lib/demo/demand-gap.ts",
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/auth0|upstash|bi-db|bi-events|@neondatabase|fetch\(|process\.env/i);
    }
  });
});

describe("demand-gap figures come from the fixture in one place", () => {
  const scenario = loadScenario();

  it("reads the headline, the series and the chart settings from the fixture, and they agree", () => {
    const gap = demandGapView(scenario);
    expect(gap.searches).toBe(2180);
    expect(gap.searchesPerDay).toEqual([96, 104, 112, 121, 130, 136, 149, 157, 166, 175, 189, 199, 216, 230]);
    expect(gap.seriesTotal).toBe(2180);
    expect(gap.seriesTotal).toBe(gap.searches);
    expect(gap.chartMax).toBe(250);
    expect(gap.seriesStartDate).toBe("2026-11-12");
    expect(gap.seriesEndDate).toBe("2026-11-25");
    expect(gap.seriesStartLabel).toBe("12 Nov");
    expect(gap.seriesEndLabel).toBe("Today");
  });

  it("follows fixture edits that keep the series and headline consistent", () => {
    const edited = editedScenario((draft) => {
      draft.gap.searchesPerDay[0] = 100;
      draft.gap.searches = 2184;
      draft.gap.chartMax = 300;
    });
    const gap = demandGapView(edited);
    expect(gap.searches).toBe(2184);
    expect(gap.searchesPerDay[0]).toBe(100);
    expect(gap.seriesTotal).toBe(2184);
    expect(gap.chartMax).toBe(300);
  });

  it("refuses a fixture whose series no longer sums to the headline", () => {
    expect(() =>
      editedScenario((draft) => {
        draft.gap.searches = 2500;
      }),
    ).toThrow(/sum to gap\.searches/);
  });

  it("is not hardcoded in any storefront or demo component", () => {
    const files = [
      ...sourceFiles("src/components/pelita"),
      ...sourceFiles("src/app/demo/pelita"),
      "src/lib/demo/storefront.ts",
      "src/lib/demo/demand-gap.ts",
      "src/lib/demo/ops-console.ts",
      "src/lib/demo/proposal.ts",
      "src/lib/demo/ops-client.ts",
      "src/app/api/demo/pelita/proposal/route.ts",
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/2,?180|1,?980|96,\s*104,\s*112|88,\s*95,\s*102/);
    }
    const html = renderStorefront();
    expect(html).not.toMatch(/2,180|1,980|\b230\b/);
  });
});

describe("the ops console reads the demand-gap figures only through demandGapView", () => {
  const renderOps = (scenario = loadScenario()) =>
    renderToStaticMarkup(createElement(PelitaOpsConsole, { view: opsConsoleView(scenario, { approvals: {}, audit: [] }) }));

  it("shows the fixture figures and follows fixture edits", () => {
    const gap = demandGapView(loadScenario());
    const html = renderOps();
    expect(html).toContain(gap.searches.toLocaleString("en-US"));
    expect(html).toContain(`data-chart-max="${gap.chartMax}"`);
    expect(html).toContain(`${gap.noPurchasePct}%`);

    const edited = editedScenario((draft) => {
      draft.gap.searchesPerDay[0] = 100;
      draft.gap.searches = 2184;
      draft.gap.chartMax = 300;
      draft.gap.matchingProductsInStock = 3;
    });
    const out = renderOps(edited);
    expect(out).toContain("2,184");
    expect(out).not.toContain("2,180");
    expect(out).toContain('data-chart-max="300"');
    expect(out).toContain(">3</div>");
  });
});

describe("Pelita theme tokens are scoped to /demo/pelita", () => {
  const css = read("src/app/globals.css");

  function block(selector: string): string {
    const start = css.indexOf(selector);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`Unclosed block ${selector}`);
  }

  function declared(body: string): Map<string, string> {
    return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().toLowerCase()]));
  }

  const tailwindDefaults = new Set(
    [...read("node_modules/tailwindcss/theme.css").matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  );

  it("defines every SPEC colour in @theme and matches the fixture palette", () => {
    const theme = declared(block("@theme {"));
    const palette = loadScenario().brand.palette;
    for (const [key, hex] of Object.entries(palette)) {
      const name = `--color-${key
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .replace(/([a-z])(\d)/g, "$1-$2")
        .toLowerCase()}`;
      expect(theme.get(name), name).toBe(hex.toLowerCase());
    }
    expect(theme.get("--color-primary")).toBe("#b5195b");
    expect(theme.get("--color-promo")).toBe("#ffc93c");
    expect(theme.get("--color-agent")).toBe("#5b3fd1");
    expect(theme.get("--color-human")).toBe("#1e3a8a");
  });

  it("keeps names that Tailwind already defines out of the global @theme", () => {
    const theme = declared(block("@theme {"));
    const collisions = [...theme.keys()].filter((name) => tailwindDefaults.has(name));
    expect(collisions).toEqual([]);
  });

  it("sets the colliding SPEC tokens only on .pelita-theme", () => {
    const scoped = declared(block(".pelita-theme {"));
    expect(scoped.get("--text-base")).toBe("18px");
    expect(scoped.get("--text-lg")).toBe("20px");
    expect(scoped.get("--radius-sm")).toBe("8px");
    expect(scoped.get("--radius-md")).toBe("12px");
    expect(scoped.get("--radius-lg")).toBe("16px");
    expect(scoped.get("--radius-xl")).toBe("20px");
    expect(scoped.get("--radius-2xl")).toBe("24px");
    expect(block(".pelita-theme {")).toContain("var(--font-figtree)");

    const withoutScoped = css.replace(block(".pelita-theme {"), "");
    expect(withoutScoped).not.toMatch(/--text-base\s*:|--text-lg\s*:|--radius-(sm|md|lg|xl|2xl)\s*:|--font-figtree/);
  });

  it("leaves the existing site's global rules alone", () => {
    expect(block(":root")).toContain("--background: #ffffff");
    expect(block("@theme inline")).toContain("--font-sans: var(--font-geist-sans)");
    expect(css).toMatch(/body\s*\{[^}]*font-family:\s*Arial, Helvetica, sans-serif/);
    expect(read("src/app/layout.tsx")).not.toMatch(/figtree|pelita/i);
  });

  it("applies the theme and loads Figtree only from the /demo/pelita layout", () => {
    const layout = read("src/app/demo/pelita/layout.tsx");
    expect(layout).toContain("Figtree");
    expect(layout).toContain("--font-figtree");
    expect(layout).toContain("pelita-theme");
    const users = sourceFiles("src")
      .filter((file) => /\.(tsx?|css)$/.test(file))
      .filter((file) => /pelita-theme|font-figtree|next\/font\/google/.test(read(file)))
      .map((file) => file.split(path.sep).join("/"))
      .sort();
    expect(users).toEqual(["src/app/demo/pelita/layout.tsx", "src/app/globals.css", "src/app/layout.tsx"]);
  });

  it("keeps violet for AI actions and navy for human approvals out of the storefront", () => {
    for (const file of sourceFiles("src/components/pelita")) {
      const text = read(file);
      expect(text, file).not.toMatch(/-(agent|human)(-50)?\b/);
      expect(text, file).not.toMatch(/#5b3fd1|#1e3a8a/i);
    }
    const html = renderStorefront();
    expect(html).not.toMatch(/(bg|text|border|stroke|fill)-(agent|human)/);
  });

  it("uses rose for the header and sun-yellow for promo ribbons", () => {
    const html = renderStorefront();
    expect(html).toMatch(/<header[^>]*bg-primary/);
    expect(html).toMatch(/bg-promo[^>]*>2 for S\$36\.00</);
  });
});
