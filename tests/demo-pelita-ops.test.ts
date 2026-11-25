import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "@/data/demo-scenario.json";
import { POST as proposalRoute } from "@/app/api/demo/pelita/proposal/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { demandGapView } from "@/lib/demo/demand-gap";
import {
  clockLabel,
  opsConsoleView,
  proposalStatus,
  sparkline,
  type OpsConsoleView,
} from "@/lib/demo/ops-console";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";
import { STATE_KEYS, appendAudit, getDemoState, recordApproval, resetDemo, setStage } from "@/lib/demo/state";
import { proxy } from "@/proxy";

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

type Command = (string | number)[];

const SECRET = "test-approval-secret";
const ENV_KEYS = ["KB_DEMO_TRACK", "VERCEL_ENV", "APPROVAL_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
const ROOT = path.resolve(__dirname, "..");
const APPROVAL_FILES = [
  "src/lib/demo/approval.ts",
  "src/lib/demo/approval-view.ts",
  "src/lib/demo/approval-client.ts",
  "src/components/pelita-ops/PelitaApprovalModal.tsx",
  "src/components/pelita-ops/PelitaLaunchApproval.tsx",
  "src/app/api/demo/pelita/approval/route.ts",
];
const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};

let store: Map<string, string | string[]>;
let sent: Command[];

function fakeRedis(commands: Command[]): unknown[] {
  return commands.map((command) => {
    sent.push(command);
    const [name, k, ...rest] = command as [string, string, ...(string | number)[]];
    switch (name) {
      case "GET":
        return { result: (store.get(k) as string | undefined) ?? null };
      case "SET":
        store.set(k, String(rest[0]));
        return { result: "OK" };
      case "DEL":
        return { result: store.delete(k) ? 1 : 0 };
      case "RPUSH": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        list.push(String(rest[0]));
        store.set(k, list);
        return { result: list.length };
      }
      case "LRANGE":
        return { result: (store.get(k) as string[] | undefined) ?? [] };
      default:
        return { error: `unsupported ${name}` };
    }
  });
}

function useFakeRedis() {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json(fakeRedis(JSON.parse(String(init?.body)) as Command[])),
    ),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = SECRET;
  cookieJar.value = signPresenterToken(SECRET);
}

function clearEnv() {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
}

function post(url: string, body: unknown, opts: { cookie?: boolean; origin?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json", origin: opts.origin ?? "https://x.test" });
  if (opts.cookie !== false) headers.set("cookie", `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}`);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function editedScenario(edit: (draft: typeof raw) => void) {
  const draft = structuredClone(raw);
  edit(draft);
  return parseScenario(draft);
}

const NOW = new Date("2026-11-25T01:14:30.000Z");

beforeEach(() => {
  clearEnv();
  store = new Map(Object.entries(FOREIGN));
  sent = [];
});

afterEach(() => {
  clearEnv();
  vi.unstubAllGlobals();
});

describe("ops console page data (screen 01)", () => {
  const scenario = loadScenario();
  const view = opsConsoleView(scenario, { approvals: {}, audit: [] });

  it("carries the demand-gap figures from demandGapView and the fixture", () => {
    expect(view.gap).toEqual(demandGapView(scenario));
    expect(view.gap).toMatchObject({
      query: "magnesium glycinate",
      searches: 2180,
      seriesTotal: 2180,
      chartMax: 250,
      matchingProductsInStock: 0,
      noPurchasePct: 64,
      seriesStartLabel: "12 Nov",
      seriesEndLabel: "Today",
    });
    expect(view.gap.searchesPerDay).toHaveLength(14);
    expect(view.headline).toBe("Shoppers want magnesium glycinate. We don't sell it.");
    expect(view.detectedLabel).toBe("Detected 09:02 today");
    expect(view.sources).toEqual(["Site search logs", "Catalogue", "Supplier price list"]);
  });

  it("describes the proposal for Magnesium Glycinate from the fixture", () => {
    expect(view.proposal).toEqual({
      title: "List Magnesium Glycinate 400 mg, 90 capsules, at S$32.90",
      supplierLine: "Supplier: Evergreen Nutrition (local)",
      art: "magnesium",
      unitsPerWeek: 140,
      grossMarginPct: 39,
      confidence: "High",
      confidencePct: 84,
    });
    expect(view.status).toBe("new");
    expect(view.rejection).toBeNull();
  });

  it("shows the seven-step rail with Detect current and agent-owned, and the signed-in person", () => {
    expect(view.steps.map((s) => s.label)).toEqual([
      "Detect",
      "Approve sourcing",
      "Stock check",
      "Draft listing",
      "Approve launch",
      "Live",
      "Audit",
    ]);
    expect(view.steps.filter((s) => s.state === "current")).toEqual([{ n: 1, label: "Detect", kind: "agent", state: "current" }]);
    expect(view.steps.filter((s) => s.kind === "human").map((s) => s.label)).toEqual(["Approve sourcing", "Approve launch"]);
    expect(view.person).toEqual({ name: "Mei Ling Goh", initials: "MG", role: "Category Manager" });
    expect(view.demoTag).toBe("DEMO DATA");
  });

  it("scales the sparkline against chartMax and follows fixture edits", () => {
    expect(view.chart.points).toHaveLength(14);
    const ys = view.chart.points.map((p) => p.y);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(view.chart.last).toEqual(view.chart.points[13]);
    expect(view.chart.points[0].x).toBe(10);
    expect(view.chart.points[13].x).toBe(view.chart.width - 10);
    expect(sparkline([50, 100], 100, 100, 100, 0).points).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 0 },
    ]);
    expect(sparkline([500], 100, 100, 100, 0).points[0].y).toBe(0);

    const edited = opsConsoleView(
      editedScenario((draft) => {
        draft.gap.chartMax = 500;
      }),
      { approvals: {}, audit: [] },
    );
    expect(edited.chart.last.y).toBeGreaterThan(view.chart.last.y);
  });

  it("renders the figures, the DEMO DATA tag and keeps violet for the agent and navy for the human", () => {
    const html = renderToStaticMarkup(createElement(PelitaOpsConsole, { view }));
    expect(html).toContain("2,180");
    expect(html).toContain("searches for “magnesium glycinate” in 14 days");
    expect(html).toContain("matching products in stock");
    expect(html).toContain("64%");
    expect(html).toContain("Searches per day");
    expect(html).toContain("12 Nov");
    expect(html).toContain("Today");
    expect(html).toContain("SHELF AGENT · DEMAND-GAP PROPOSAL");
    expect(html).toContain("PROPOSED");
    expect(html).toContain("140");
    expect(html).toContain("confidence · 84%");
    expect(html).toMatch(/<span data-demo-tag="[^"]*"[^>]*>DEMO DATA<\/span>/);
    expect(html).toContain('data-proposal-status="new"');

    const button = (label: string) => {
      const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
      expect(match, label).not.toBeNull();
      return match![0];
    };
    const disabled = /\sdisabled(=""|\s|>)/;
    expect(button("Approve…")).toContain("bg-human");
    expect(button("Approve…")).toMatch(disabled);
    expect(button("Edit")).toMatch(disabled);
    expect(button("Reject")).not.toMatch(disabled);
    for (const label of ["Reject", "Edit", "Reset demo"]) {
      expect(button(label)).not.toMatch(/agent|human/);
    }
    expect(html).toContain("text-agent");
    expect(html).toContain("bg-agent-50");
    // Navy is only the Approve button, the current-step marker for a human step and the person's avatar.
    expect(html.match(/bg-human/g)).toHaveLength(2);
  });

  it("holds none of the demand-gap numbers in its own source", () => {
    for (const file of [
      "src/lib/demo/ops-console.ts",
      "src/components/pelita-ops/PelitaOpsConsole.tsx",
      "src/app/demo/pelita/ops/page.tsx",
      ...APPROVAL_FILES,
    ]) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/2,?180|\b250\b|96,\s*104|\b64\b|\b84\b|\b140\b|\b39\b/);
    }
  });
});

describe("ops console touches no database, identity or env", () => {
  it("only reaches the demo API and the prefixed state module", () => {
    const files = [
      "src/components/pelita-ops/PelitaOpsConsole.tsx",
      "src/app/demo/pelita/ops/page.tsx",
      "src/lib/demo/ops-console.ts",
      "src/lib/demo/proposal.ts",
      "src/lib/demo/ops-client.ts",
      "src/app/api/demo/pelita/proposal/route.ts",
      ...APPROVAL_FILES,
    ];
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/auth0|@neondatabase|bi-db|bi-events|process\.env|redisPipeline|from "\.\.?\/(\.\.\/)?upstash"/i);
    }
    expect(readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaOpsConsole.tsx"), "utf8")).not.toMatch(/fetch\(/);
    const client = readFileSync(path.join(ROOT, "src/lib/demo/ops-client.ts"), "utf8");
    expect([...client.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1])).toEqual(["/api/demo/pelita/proposal", "/api/demo/pelita/reset"]);
  });
});

describe("/demo/pelita/ops gate", () => {
  async function loadPage() {
    return (await import("@/app/demo/pelita/ops/page")).default;
  }
  const notFound = { digest: expect.stringContaining("404") };

  it("is a 404 when the track flag is off, even with a valid cookie", async () => {
    process.env.APPROVAL_SECRET = SECRET;
    cookieJar.value = signPresenterToken(SECRET);
    await expect((await loadPage())()).rejects.toMatchObject(notFound);
  });

  it("keeps the prod refusal: 404 on Vercel production with the flag and a valid cookie", async () => {
    openGate();
    process.env.VERCEL_ENV = "production";
    await expect((await loadPage())()).rejects.toMatchObject(notFound);
  });

  it("is a 404 without a cookie or with a forged one", async () => {
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    const Page = await loadPage();
    await expect(Page()).rejects.toMatchObject(notFound);
    cookieJar.value = `${signPresenterToken(SECRET)}0`;
    await expect(Page()).rejects.toMatchObject(notFound);
    cookieJar.value = signPresenterToken("some-other-secret");
    await expect(Page()).rejects.toMatchObject(notFound);
  });

  it("is refused by the proxy with a real 404 unless the gate is open and the cookie is valid", async () => {
    const ops = (cookie?: string) =>
      proxy(new NextRequest("https://x.test/demo/pelita/ops", cookie ? { headers: { cookie } } : undefined));
    const token = signPresenterToken(SECRET);
    expect((await ops(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
    process.env.KB_DEMO_TRACK = "pelita";
    process.env.APPROVAL_SECRET = SECRET;
    expect((await ops()).status).toBe(404);
    expect((await ops(`${PRESENTER_COOKIE}=${token}x`)).status).toBe(404);
    expect((await ops(`${PRESENTER_COOKIE}=${token}`)).status).toBe(200);
    process.env.VERCEL_ENV = "production";
    expect((await ops(`${PRESENTER_COOKIE}=${token}`)).status).toBe(404);
  });

  it("renders screen 01 for a presenter from the persisted state", async () => {
    openGate();
    useFakeRedis();
    const scenario = loadScenario();
    const Page = await loadPage();

    let element = await Page();
    expect(isValidElement(element)).toBe(true);
    let props = (element as ReactElement<{ view: OpsConsoleView }>).props;
    expect((element as ReactElement).type).toBe(PelitaOpsConsole);
    expect(props.view.status).toBe("new");

    await rejectProposal(scenario, NOW);
    element = await Page();
    props = (element as ReactElement<{ view: OpsConsoleView }>).props;
    expect(props.view.status).toBe("rejected");
    expect(props.view.rejection).toMatchObject({ by: "Mei Ling Goh", atLabel: "09:14" });
  });

  it("still shows a new proposal when the store is not configured, without writing anywhere", async () => {
    openGate();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const element = await (await loadPage())();
    expect((element as ReactElement<{ view: OpsConsoleView }>).props.view.status).toBe("new");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("proposal API gate", () => {
  const url = "https://x.test/api/demo/pelita/proposal";

  it("answers 404 for every request when the gate is closed or the cookie is missing", async () => {
    expect((await proposalRoute(post(url, { action: "reject" }))).status).toBe(404);
    openGate();
    expect((await proposalRoute(post(url, { action: "reject" }, { cookie: false }))).status).toBe(404);
    process.env.VERCEL_ENV = "production";
    expect((await proposalRoute(post(url, { action: "reject" }))).status).toBe(404);
  });

  it("refuses cross-site writes, unknown actions and unreadable bodies, and 503s without a store", async () => {
    openGate();
    expect((await proposalRoute(post(url, { action: "reject" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await proposalRoute(post(url, { action: "approve" }))).status).toBe(400);
    expect((await proposalRoute(post(url, null))).status).toBe(400);
    const garbled = new Request(url, {
      method: "POST",
      headers: { origin: "https://x.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` },
      body: "{nope",
    });
    expect((await proposalRoute(garbled)).status).toBe(400);
    expect((await proposalRoute(post(url, { action: "reject" }))).status).toBe(503);
  });

  it("rejects the proposal for a presenter and tags the response as demo data", async () => {
    openGate();
    useFakeRedis();
    const res = await proposalRoute(post(url, { action: "reject" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({ isDemo: true, ok: true, changed: true, status: "rejected" });
    expect(body.rejection.by).toBe("Mei Ling Goh");
    expect((await getDemoState()).audit).toHaveLength(1);
  });

  it("answers 409 once the sourcing approval exists", async () => {
    openGate();
    useFakeRedis();
    await recordApproval("sourcing", { approvalId: "APR-2051", approverId: "mei-ling-goh", at: "2026-11-25T09:03:35+08:00" });
    expect((await proposalRoute(post(url, { action: "reject" }))).status).toBe(409);
    expect((await getDemoState()).audit).toEqual([]);
  });
});

describe("proposal state transitions", () => {
  const scenario = loadScenario();

  beforeEach(useFakeRedis);

  it("starts new, becomes rejected with one audit row, and stays rejected on a repeat", async () => {
    expect(proposalStatus(scenario, await getDemoState())).toBe("new");

    const first = await rejectProposal(scenario, NOW);
    expect(first).toMatchObject({ ok: true, changed: true, status: "rejected" });
    const state = await getDemoState();
    expect(proposalStatus(scenario, state)).toBe("rejected");
    expect(state.audit).toEqual([
      {
        at: "2026-11-25T01:14:30.000Z",
        actorKind: "human",
        actor: "Mei Ling Goh",
        action: "Rejected proposal: List Magnesium Glycinate 400 mg, 90 capsules, at S$32.90",
        source: "Ops console",
        ref: "PRP-3184",
      },
    ]);
    expect(clockLabel(state.audit[0].at)).toBe("09:14");

    const second = await rejectProposal(scenario, new Date("2026-11-25T02:00:00.000Z"));
    expect(second).toMatchObject({ ok: true, changed: false, status: "rejected" });
    expect((await getDemoState()).audit).toHaveLength(1);
  });

  it("does not treat unrelated audit rows as a rejection", async () => {
    await appendAudit({ at: NOW.toISOString(), actorKind: "agent", actor: "Shelf Agent", action: "Spotted gap", source: "Site search logs", ref: "PRP-3184" });
    await appendAudit({ at: NOW.toISOString(), actorKind: "human", actor: "Someone", action: "Rejected proposal: other", source: "Ops console", ref: "PRP-9999" });
    expect(proposalStatus(scenario, await getDemoState())).toBe("new");
  });

  it("refuses to reject after sourcing is approved and writes nothing", async () => {
    await recordApproval("sourcing", { approvalId: "APR-2051", approverId: "mei-ling-goh", at: "2026-11-25T09:03:35+08:00" });
    expect(await rejectProposal(scenario, NOW)).toEqual({ ok: false, status: "approved" });
    expect((await getDemoState()).audit).toEqual([]);
    expect(proposalStatus(scenario, await getDemoState())).toBe("approved");
    const view = opsConsoleView(scenario, await getDemoState());
    expect(view.steps.find((s) => s.state === "current")?.label).toBe("Approve sourcing");
    expect(view.steps[0].state).toBe("done");
  });

  it("writes only to the fixed key list under kb:demo:pelita:", async () => {
    await setStage(1);
    await rejectProposal(scenario, NOW);
    await rejectProposal(scenario, NOW);
    await getDemoState();
    await resetDemo();
    expect(sent.length).toBeGreaterThan(0);
    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(String(target).startsWith("kb:demo:pelita:")).toBe(true);
      expect(STATE_KEYS).toContain(target);
    }
  });

  it("is cleared by resetDemo, and by the reset route, leaving foreign keys alone", async () => {
    await rejectProposal(scenario, NOW);
    expect(proposalStatus(scenario, await getDemoState())).toBe("rejected");

    const state = await resetDemo();
    expect(state).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(proposalStatus(scenario, await getDemoState())).toBe("new");
    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);

    openGate();
    await rejectProposal(scenario, NOW);
    const res = await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined));
    expect(res.status).toBe(200);
    expect(proposalStatus(scenario, await getDemoState())).toBe("new");
    expect(store.get("kb:demo:pelita:audit")).toBeUndefined();
    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);
  });

  it("can be rejected again after a reset", async () => {
    await rejectProposal(scenario, NOW);
    await resetDemo();
    expect(await rejectProposal(scenario, NOW)).toMatchObject({ ok: true, changed: true });
    expect((await getDemoState()).audit).toHaveLength(1);
  });
});
