import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashShopperId } from "@/lib/bi-hash";
import { POST as purchaseRoute } from "@/app/api/demo/pelita/yuu/purchase/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { POST as simulateRoute } from "@/app/api/demo/pelita/yuu/simulate/route";
import { POST as detectRoute } from "@/app/api/demo/pelita/yuu/detect/route";
import { GET as loyaltyRoute } from "@/app/api/bi/loyalty/route";
import { GET as transactionsRoute } from "@/app/api/bi/loyalty/transactions/route";
import { POST as signalRoute } from "@/app/api/bi/loyalty/signal/route";
import { getDemoState } from "@/lib/demo/state";
import { loadScenario } from "@/lib/demo/scenario";
import { capYuu, readYuuAccount, withPurchase, YUU_META_MAX_BYTES, YUU_PURCHASE_CAP, type YuuStoredPurchase } from "@/lib/yuu/account";
import { yuuWebhookSignature } from "@/lib/yuu/webhook";
import { YUU_DEFAULT_STORE_ID } from "@/lib/yuu/stores";
import { readYuuPanel, runYuuDetector } from "@/lib/yuu/db";
import { classifyPurchases, yuuSkuBlocked, yuuThresholds, YUU_REASON, type LoyaltyPurchase } from "@/lib/yuu/detector";
import { tierForPoints } from "@/lib/yuu/tier";
import { evalFenced } from "./helpers/fake-redis-eval";

const getShopper = vi.hoisted(() => vi.fn(async () => null as { id: string; name?: string } | null));
const neonMock = vi.hoisted(() => vi.fn());
const auth0 = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  patches: [] as { userId: string; patch: Record<string, unknown> }[],
  complete: true,
}));

vi.mock("@/lib/shopper", () => ({ getShopper }));
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () =>
    Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_MGMT_CLIENT_ID && process.env.AUTH0_MGMT_CLIENT_SECRET),
  getAppMetadata: async (userId: string) => structuredClone(auth0.users.get(userId) ?? {}),
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    auth0.patches.push({ userId, patch: structuredClone(patch) });
    const current = { ...(auth0.users.get(userId) ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete current[key];
      else current[key] = structuredClone(value);
    }
    auth0.users.set(userId, current);
    return structuredClone(current);
  },
  listUsersAppMetadata: async () => ({
    users: [...auth0.users.entries()].map(([userId, appMetadata]) => ({
      userId,
      appMetadata: structuredClone(appMetadata),
    })),
    complete: auth0.complete,
  }),
}));

const SECRET = "test-bi-api-secret-0123456789";
const HASH = "test-bi-hash-secret-0123456789";
const APPROVAL = "test-approval-secret";

type Command = (string | number)[];
type Signal = {
  id: string;
  sku: string;
  product_name: string;
  score: number;
  window_minutes: number;
  distinct_members: number;
  total_qty: number;
  status: string;
  reason: string | null;
  source: string;
  proposal_ref: string | null;
  window_day: string;
  detected_at?: string;
  webhook_status?: string | null;
  webhook_code?: number | null;
};

let signals: Map<string, Signal>;
let nextSignalId: number;
let events: unknown[];
let queries: string[];
let store: Map<string, string | string[]>;
let dbCount = 0;

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function handle(text: string, params: unknown[] = []): unknown[] {
  const sql = flat(text);
  queries.push(sql);
  if (sql.startsWith("select to_char")) return [{ day: "2026-11-26" }];
  if (sql.startsWith("insert into bi_events")) {
    events.push(params);
    return [];
  }
  if (sql.startsWith("insert into yuu_signals")) {
    const [sku, productName, score, windowMinutes, distinctMembers, totalQty, status, reason, windowDay, detectedAt] = params as [
      string, string, number, number, number, number, string, string | null, string, string,
    ];
    const id = String(nextSignalId++);
    signals.set(id, {
      id,
      sku,
      product_name: productName,
      score: Number(score),
      window_minutes: Number(windowMinutes),
      distinct_members: Number(distinctMembers),
      total_qty: Number(totalQty),
      status,
      reason,
      source: "detector",
      proposal_ref: null,
      window_day: windowDay,
      detected_at: detectedAt,
      webhook_status: null,
      webhook_code: null,
    });
    return [];
  }
  if (sql.startsWith("delete from yuu_signals where window_day")) {
    const day = String(params[0]);
    const keep = new Set((params[1] as string[]) ?? []);
    for (const [key, signal] of signals) {
      if (signal.window_day === day && !signal.proposal_ref && !keep.has(signal.sku)) signals.delete(key);
    }
    return [];
  }
  if (sql.startsWith("select id::text as id, status")) {
    const [sku, window] = params as [string, number];
    return [...signals.values()].filter((signal) => signal.sku === sku && signal.window_minutes === Number(window));
  }
  if (sql.startsWith("select") && sql.includes("from yuu_signals") && sql.includes("where sku =")) {
    const [sku, window, day] = params as [string, number, string];
    return [...signals.values()].filter(
      (signal) => signal.sku === sku && signal.window_minutes === Number(window) && signal.window_day === day,
    );
  }
  if (sql.startsWith("select") && sql.includes("from yuu_signals")) {
    return [...signals.values()].filter((signal) => signal.window_day === params[0]);
  }
  if (sql.startsWith("update yuu_signals") && sql.includes("set product_name")) {
    const [productName, score, distinctMembers, totalQty, status, reason, windowDay, id] = params as [
      string, number, number, number, string, string | null, string, string,
    ];
    const signal = [...signals.values()].find((row) => row.id === String(id));
    if (!signal) return [];
    signal.product_name = productName;
    signal.score = Number(score);
    signal.distinct_members = Number(distinctMembers);
    signal.total_qty = Number(totalQty);
    signal.window_day = windowDay;
    if (!(signal.source === "bi_bot" && signal.proposal_ref)) {
      signal.status = status;
      signal.reason = reason;
      signal.source = "detector";
    }
    return [];
  }
  if (sql.startsWith("update yuu_signals") && sql.includes("set webhook_status")) {
    const id = String(params[0]);
    const signal = [...signals.values()].find((row) => row.id === id);
    if (!signal || signal.webhook_status === "sent") return [];
    if (sql.includes("webhook_status = 'pending'")) {
      if (signal.webhook_status && signal.webhook_status !== "failed" && signal.webhook_status !== "unconfigured") return [];
      signal.webhook_status = "pending";
      signal.webhook_code = null;
      return [{ id }];
    }
    signal.webhook_status = String(params[1]);
    signal.webhook_code = params[2] == null ? null : Number(params[2]);
    return [{ id }];
  }
  if (sql.startsWith("update yuu_signals")) {
    const [reason, proposalRef, id] = params as [string, string, string];
    const signal = [...signals.values()].find((row) => row.id === String(id));
    if (!signal || signal.proposal_ref || (signal.status !== "shortlisted" && signal.status !== "escalated")) return [];
    signal.source = "bi_bot";
    signal.reason = reason;
    signal.proposal_ref = proposalRef;
    return [signal];
  }
  if (sql === "delete from yuu_transactions" || sql === "delete from yuu_signals" || sql === "delete from yuu_members") {
    if (sql.endsWith("yuu_signals")) signals.clear();
    return [];
  }
  if (sql.startsWith("delete from bi_events")) {
    events = [];
    return [];
  }
  throw new Error(`unhandled sql: ${sql.slice(0, 180)}`);
}

function installSql(): void {
  dbCount += 1;
  process.env.DATABASE_URL = `postgres://user:pw@db${dbCount}.example/neondb`;
  const query = (text: string, params?: unknown[]) => Promise.resolve(handle(text, params));
  const sql = Object.assign(query, {
    query,
    transaction: (fn: (txn: { query: typeof query }) => Promise<unknown>[]) => Promise.all(fn({ query })),
  });
  neonMock.mockReset();
  neonMock.mockReturnValue(sql);
}

function installRedis(): void {
  store = new Map();
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as Command[];
      const results = commands.map((command) => {
        if (command[0] === "EVAL") {
          return evalFenced(command, (key) => store.get(key) as string | undefined, (inner) => {
            const [name, key, ...rest] = inner as [string, string, ...(string | number)[]];
            if (name === "RPUSH") {
              const list = (store.get(key) as string[] | undefined) ?? [];
              list.push(String(rest[0]));
              store.set(key, list);
              return { result: list.length };
            }
            if (name === "SET") {
              store.set(key, String(rest[0]));
              return { result: "OK" };
            }
            if (name === "DEL") return { result: store.delete(key) ? 1 : 0 };
            if (name === "GET") return { result: (store.get(key) as string | undefined) ?? null };
            return { error: `unsupported ${name}` };
          });
        }
        const [name, key, ...rest] = command as [string, string, ...(string | number)[]];
        if (name === "GET") return { result: (store.get(key) as string | undefined) ?? null };
        if (name === "SET") {
          store.set(key, String(rest[0]));
          return { result: "OK" };
        }
        if (name === "DEL") return { result: store.delete(key) ? 1 : 0 };
        if (name === "RPUSH") {
          const list = (store.get(key) as string[] | undefined) ?? [];
          list.push(String(rest[0]));
          store.set(key, list);
          return { result: list.length };
        }
        if (name === "LRANGE") return { result: (store.get(key) as string[] | undefined) ?? [] };
        return { error: `unsupported ${name}` };
      });
      return Response.json(results);
    }),
  );
}

function openDemo(): void {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = APPROVAL;
}

function openAuth0(): void {
  process.env.AUTH0_DOMAIN = "tenant.example";
  process.env.AUTH0_MGMT_CLIENT_ID = "mgmt-client";
  process.env.AUTH0_MGMT_CLIENT_SECRET = "mgmt-secret";
}

function demoPost(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: "https://x.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function bearer(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SECRET}`);
  return new Request(url, { ...init, headers });
}

function buy(partial: Partial<LoyaltyPurchase> & Pick<LoyaltyPurchase, "sku" | "memberId">): LoyaltyPurchase {
  return {
    productName: partial.productName ?? partial.sku,
    qty: 1,
    amountCents: 1000,
    isTest: false,
    ...partial,
  };
}

function repeat(sku: string, memberIds: string[], times: number, extra: Partial<LoyaltyPurchase> = {}): LoyaltyPurchase[] {
  const rows: LoyaltyPurchase[] = [];
  for (const memberId of memberIds) {
    for (let n = 0; n < times; n += 1) rows.push(buy({ sku, memberId, ...extra }));
  }
  return rows;
}

function purchaseOf(at: string, sku = "PL-20055"): YuuStoredPurchase {
  return { sku, name: "Magnesium Glycinate 400 mg", qty: 1, cents: 3290, points: 32, at };
}

async function buyAs(userId: string, sku: string, qty = 1, channel?: "web" | "partner"): Promise<Response> {
  getShopper.mockResolvedValue({ id: userId, name: "Ada Lovelace" });
  return purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku, qty, ...(channel ? { channel } : {}) }));
}

beforeEach(() => {
  signals = new Map();
  nextSignalId = 1;
  events = [];
  queries = [];
  store = new Map();
  auth0.users = new Map();
  auth0.patches = [];
  auth0.complete = true;
  getShopper.mockReset();
  getShopper.mockResolvedValue(null);
  process.env.BI_HASH_SECRET = HASH;
  process.env.BI_API_SECRET = SECRET;
  openDemo();
  openAuth0();
  installSql();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DATABASE_URL;
  delete process.env.BI_HASH_SECRET;
  delete process.env.BI_API_SECRET;
  delete process.env.KB_DEMO_TRACK;
  delete process.env.APPROVAL_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.AUTH0_DOMAIN;
  delete process.env.AUTH0_MGMT_CLIENT_ID;
  delete process.env.AUTH0_MGMT_CLIENT_SECRET;
  delete process.env.YUU_MIN_REPEAT_MEMBERS;
  delete process.env.YUU_MIN_SCORE;
  delete process.env.YUU_WINDOW_MINUTES;
  delete process.env.YUU_SIGNAL_WEBHOOK_URL;
  delete process.env.YUU_SIGNAL_WEBHOOK_SECRET;
  delete process.env.APP_BASE_URL;
  delete process.env.APP_URL;
});

describe("yuu tier and detector", () => {
  it("derives Member, Silver and Gold from points", () => {
    expect(tierForPoints(0)).toBe("Member");
    expect(tierForPoints(499)).toBe("Member");
    expect(tierForPoints(500)).toBe("Silver");
    expect(tierForPoints(1999)).toBe("Silver");
    expect(tierForPoints(2000)).toBe("Gold");
  });

  it("escalates two repeat shoppers and drops a single bulk buy", () => {
    const sku = loadScenario().proposal.productId;
    const decisions = classifyPurchases(
      [...repeat(sku, ["a", "b"], 2), buy({ sku: "PL-80014", memberId: "c", qty: 12 })],
      (id) => yuuSkuBlocked(id, false),
    );
    const bySku = new Map(decisions.map((decision) => [decision.sku, decision]));
    expect(bySku.get(sku)).toMatchObject({ status: "escalated", score: 4, distinctMembers: 2, repeatMembers: 2 });
    expect(bySku.get("PL-80014")).toMatchObject({ status: "dropped", reason: YUU_REASON.singleMemberBulk, distinctMembers: 1 });
    expect(decisions.filter((decision) => decision.status === "escalated")).toHaveLength(1);
    expect(yuuThresholds()).toEqual({ minRepeatMembers: 2, minScore: 2 });
  });

  it("raises the bar when the threshold env is set, and ignores an invalid value", () => {
    process.env.YUU_MIN_REPEAT_MEMBERS = "3";
    process.env.YUU_MIN_SCORE = "6";
    const held = classifyPurchases(repeat("PL-20055", ["a", "b"], 2));
    expect(held[0]).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold, score: 4 });
    process.env.YUU_MIN_REPEAT_MEMBERS = "nope";
    expect(yuuThresholds().minRepeatMembers).toBe(2);
  });

  it("drops test-member trends and a strong trend on a sku that is already listed", () => {
    const tested = classifyPurchases(repeat("PL-80027", ["t1", "t2", "t3", "t4"], 2, { isTest: true }));
    expect(tested[0]).toMatchObject({ status: "dropped", reason: YUU_REASON.testMembers });
    const listed = classifyPurchases(repeat("PL-20013", ["a", "b", "c", "d"], 2), (sku) => yuuSkuBlocked(sku, false));
    expect(listed[0]).toMatchObject({ status: "dropped", reason: YUU_REASON.alreadyListed, score: 16 });
  });

  it("keeps the demand-gap sku eligible until the launch lists it", () => {
    const sku = loadScenario().proposal.productId;
    expect(yuuSkuBlocked(sku, false)).toBe(false);
    expect(yuuSkuBlocked(sku, true)).toBe(true);
    expect(yuuSkuBlocked("PL-20013", false)).toBe(true);
  });

  it("caps stored purchases and keeps the running points", () => {
    let account = readYuuAccount(null);
    const total = YUU_PURCHASE_CAP + 5;
    for (let n = 0; n < total; n += 1) {
      account = withPurchase(account, purchaseOf(new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString()));
    }
    expect(account?.purchases.length).toBeLessThanOrEqual(YUU_PURCHASE_CAP);
    expect(account?.purchases.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(account)).length).toBeLessThanOrEqual(YUU_META_MAX_BYTES);
    expect(account?.points).toBe(32 * total);
    expect(capYuu(account!).purchases[0]?.at).not.toBe(purchaseOf(new Date(Date.UTC(2026, 0, 1)).toISOString()).at);
  });
});

describe("migration", () => {
  it("keeps the signal table and removes the simulated member ledger", () => {
    const original = readFileSync("db/migrations/0004_yuu_loyalty.sql", "utf8");
    const follow = readFileSync("db/migrations/0005_yuu_auth0.sql", "utf8");
    expect(original).toContain("CREATE TABLE IF NOT EXISTS yuu_members");
    expect(original).toContain("CREATE TABLE IF NOT EXISTS yuu_transactions");
    expect(original).toContain("CREATE TABLE IF NOT EXISTS yuu_signals");
    expect(original).toContain("UNIQUE (sku, window_minutes, window_day)");
    expect(original).toContain("CHECK (channel IN ('web', 'sim'))");
    expect(original).toContain("CHECK (status IN ('dropped', 'shortlisted', 'escalated'))");
    expect(original).not.toContain("Aisha Rahman");
    expect(follow).toContain("DELETE FROM yuu_transactions");
    expect(follow).toContain("DELETE FROM yuu_members");
    expect(follow).not.toContain("DELETE FROM yuu_signals");
    const windows = readFileSync("db/migrations/0007_yuu_signal_windows.sql", "utf8");
    expect(windows).toContain("ADD COLUMN IF NOT EXISTS detected_at");
    expect(windows).toContain("DROP CONSTRAINT IF EXISTS yuu_signals_sku_window_minutes_window_day_key");
    expect(windows).toContain("CREATE INDEX IF NOT EXISTS yuu_signals_sku_window_detected_idx");
    expect(windows).not.toContain("DELETE FROM yuu_signals");
  });
});

describe("purchase API", () => {
  it("requires a signed-in shopper and records the purchase only on app_metadata.yuu", async () => {
    const signedOut = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", qty: 1 }));
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "sign_in_required" });

    const persona = await purchaseRoute(
      demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", qty: 1, memberId: "sim-aisha-rahman" }),
    );
    expect(persona.status).toBe(400);

    auth0.users.set("auth0|ada", { orders: [{ id: "order-1" }], cart: { items: [{ productId: "mug" }] } });
    const res = await buyAs("auth0|ada", "PL-80014", 1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      label: "yuu (simulated)",
      memberId: "self",
      displayName: "You",
      sku: "PL-80014",
      qty: 1,
      amountSgd: "11.90",
      pointsEarned: 11,
      points: 11,
      tier: "Member",
      channel: "web",
    });
    expect(JSON.stringify(body)).not.toContain("auth0|ada");
    expect(JSON.stringify(body)).not.toContain("Ada");
    const stored = auth0.users.get("auth0|ada");
    expect(stored?.orders).toEqual([{ id: "order-1" }]);
    expect(stored?.cart).toEqual({ items: [{ productId: "mug" }] });
    expect(auth0.patches).toHaveLength(1);
    expect(Object.keys(auth0.patches[0]?.patch ?? {})).toEqual(["yuu"]);
    const yuu = stored?.yuu as { points: number; purchases: { sku: string }[] };
    expect(yuu.points).toBe(11);
    expect(yuu.purchases).toHaveLength(1);
    expect(JSON.stringify(yuu)).not.toContain("auth0|ada");
    const recorded = events[0] as unknown[];
    expect(recorded[0]).toBe(hashShopperId("auth0|ada"));
    expect(recorded[1]).toBe("yuu-web");
    expect(JSON.stringify(recorded)).not.toContain("auth0|ada");
    expect(JSON.parse(String(recorded[2]))).toEqual({ sku: "PL-80014", qty: 1, amountCents: 1190, channel: "web" });
    const signal = [...signals.values()].find((row) => row.sku === "PL-80014");
    expect(signal).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold });
    expect(queries.some((query) => query.startsWith("insert into yuu_transactions"))).toBe(false);
    expect(queries.some((query) => query.startsWith("insert into yuu_members"))).toBe(false);
  });

  it("refuses a cross-site post and a closed gate", async () => {
    const cross = await purchaseRoute(new Request("https://x.test/api/demo/pelita/yuu/purchase", { method: "POST", body: "{}" }));
    expect(cross.status).toBe(403);
    delete process.env.KB_DEMO_TRACK;
    const closed = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014" }));
    expect(closed.status).toBe(404);
  });

  it("records a partner purchase of the unlisted demand-gap sku", async () => {
    const sku = loadScenario().proposal.productId;
    const res = await buyAs("auth0|ada", sku, 1, "partner");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      sku,
      amountSgd: "32.90",
      pointsEarned: 32,
      points: 32,
      channel: "partner",
    });
    const yuu = auth0.users.get("auth0|ada")?.yuu as { purchases: { sku: string; channel: string }[] };
    expect(yuu.purchases[0]).toMatchObject({ sku, channel: "partner" });
    const recorded = events[0] as unknown[];
    expect(recorded[1]).toBe("yuu-partner");
    expect(JSON.parse(String(recorded[2]))).toMatchObject({ sku, channel: "partner", amountCents: 3290 });
    const signal = [...signals.values()].find((row) => row.sku === sku);
    expect(signal).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold });
  });

  it("refuses the write when the shopper's metadata has no room for yuu", async () => {
    auth0.users.set("auth0|ada", { orders: "x".repeat(20_000) });
    const res = await buyAs("auth0|ada", "PL-80014", 1);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "metadata_full" });
    expect(auth0.patches).toHaveLength(0);
    expect(auth0.users.get("auth0|ada")?.orders).toBe("x".repeat(20_000));
  });

  it("retires the simulate burst", async () => {
    const res = await simulateRoute(demoPost("https://x.test/api/demo/pelita/yuu/simulate"));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "retired" });
    const cross = await simulateRoute(new Request("https://x.test/api/demo/pelita/yuu/simulate", { method: "POST" }));
    expect(cross.status).toBe(403);
  });
});

describe("BI loyalty API", () => {
  it("is 401 without the bearer secret and reads members from Auth0", async () => {
    const open = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty"));
    expect(open.status).toBe(401);
    const wrong = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty", { headers: { authorization: "Bearer wrong" } }));
    expect(wrong.status).toBe(401);
    delete process.env.BI_API_SECRET;
    const unconfigured = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty"));
    expect(unconfigured.status).toBe(503);
    process.env.BI_API_SECRET = SECRET;
    delete process.env.AUTH0_MGMT_CLIENT_ID;
    const noAuth0 = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty"));
    expect(noAuth0.status).toBe(503);
    openAuth0();
    const ok = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      label: "yuu (simulated)",
      windowMinutes: 60,
      minRepeatMembers: 2,
      minScore: 2,
      scanComplete: true,
      members: { count: 0, tierMix: { Member: 0, Silver: 0, Gold: 0 }, excludedTest: 0 },
      transactions: { count: 0 },
      skus: [],
      signals: [],
    });
  });

  it("counts in-window purchases and leaves test shoppers out of the score", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    auth0.users.set("auth0|old", {
      yuu: { points: 32, purchases: [purchaseOf(old)] },
    });
    auth0.users.set("auth0|test", {
      is_test: true,
      yuu: { points: 64, purchases: [purchaseOf(new Date().toISOString()), purchaseOf(new Date().toISOString())] },
    });
    const report = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty"));
    expect(report.status).toBe(200);
    const body = await report.json();
    expect(body.members).toMatchObject({ count: 1, excludedTest: 1 });
    expect(body.transactions.count).toBe(0);
    expect(body.skus).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("auth0|");
  });

  it("refuses a signal without the bearer secret", async () => {
    const res = await signalRoute(new Request("https://x.test/api/bi/loyalty/signal", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("detection, signal and reset", () => {
  beforeEach(() => {
    installRedis();
  });

  it("escalates two real shoppers and files the approval-1 proposal once", async () => {
    const strongSku = loadScenario().proposal.productId;
    expect((await buyAs("auth0|ada", strongSku)).status).toBe(200);
    expect((await buyAs("auth0|ada", strongSku)).status).toBe(200);
    expect((await buyAs("auth0|ben", strongSku)).status).toBe(200);
    expect((await buyAs("auth0|ben", strongSku)).status).toBe(200);
    expect((await buyAs("auth0|cara", "PL-80014", 12)).status).toBe(200);

    const detected = await detectRoute(demoPost("https://x.test/api/demo/pelita/yuu/detect"));
    expect(detected.status).toBe(200);
    const panel = await detected.json();
    const strong = panel.signals.find((signal: { sku: string }) => signal.sku === strongSku);
    const bulk = panel.signals.find((signal: { sku: string }) => signal.sku === "PL-80014");
    expect(strong).toMatchObject({ status: "escalated", source: "detector", score: 4, distinctMembers: 2 });
    expect(bulk).toMatchObject({ status: "dropped", reason: YUU_REASON.singleMemberBulk });
    expect(panel.members).toHaveLength(3);
    expect(panel.members.every((member: { displayName: string; id: string }) => member.displayName.startsWith("Member ") && !member.id.includes("auth0"))).toBe(true);
    expect(JSON.stringify(panel)).not.toContain("Ada");

    const report = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty?window_minutes=60"));
    expect(report.status).toBe(200);
    const loyalty = await report.json();
    expect(loyalty.transactions.count).toBe(5);
    expect(loyalty.members.count).toBe(3);
    expect(loyalty.skus.find((row: { sku: string }) => row.sku === strongSku).score).toBe(4);
    expect(JSON.stringify(loyalty)).not.toContain("auth0|");

    const rationale = "Two signed-in shoppers are repeat-buying magnesium glycinate inside the hour.";
    const filed = await signalRoute(bearer("https://x.test/api/bi/loyalty/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: strongSku, rationale, confidence: 0.84 }),
    }));
    expect(filed.status).toBe(200);
    const filedBody = await filed.json();
    expect(filedBody).toMatchObject({ ok: true, idempotent: false, proposalStatus: "awaiting_approval_1", proposalRef: loadScenario().gap.id });
    expect(filedBody.signal).toMatchObject({ source: "bi_bot", reason: rationale, status: "escalated" });

    const state = await getDemoState();
    expect(state.stage).toBe(0);
    expect(state.approvals).toEqual({});
    expect(state.audit.map((row) => row.action)).toEqual([
      expect.stringContaining("yuu (simulated) signal"),
      expect.stringContaining(rationale),
    ]);
    expect(state.audit[0]?.actorKind).toBe("agent");
    expect(state.audit[1]?.actor).toBe("BI bot");
    expect(state.audit.every((row) => row.actorKind !== "human")).toBe(true);

    const again = await signalRoute(bearer("https://x.test/api/bi/loyalty/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: strongSku, rationale: "A different rationale that must not be written twice.", confidence: 90 }),
    }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ idempotent: true, proposalRef: loadScenario().gap.id });
    expect((await getDemoState()).audit).toHaveLength(2);

    const weak = await signalRoute(bearer("https://x.test/api/bi/loyalty/signal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "PL-80014", rationale: "This bulk buy should not become a proposal.", confidence: 0.2 }),
    }));
    expect(weak.status).toBe(422);
    expect(await weak.json()).toEqual({ error: "signal_not_actionable", reason: YUU_REASON.singleMemberBulk });
  });

  it("clears only the yuu key and the neon signal rows", async () => {
    auth0.users.set("auth0|ada", {
      orders: [{ id: "order-1" }],
      cart: { items: [] },
      yuu: { points: 11, purchases: [purchaseOf(new Date().toISOString(), "PL-80014")] },
    });
    auth0.users.set("auth0|ben", { orders: [{ id: "order-2" }] });
    signals.set("PL-20055|60|2026-11-26", {
      id: "1",
      sku: "PL-20055",
      product_name: "Magnesium",
      score: 4,
      window_minutes: 60,
      distinct_members: 2,
      total_qty: 4,
      status: "escalated",
      reason: "strongest repeat trend",
      source: "bi_bot",
      proposal_ref: "gap",
      window_day: "2026-11-26",
    });
    events.push({ shopper_hash: "abc" });
    store.set("kb:demo:pelita:stage", "4");

    const res = await resetRoute(demoPost("https://x.test/api/demo/pelita/reset"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(signals.size).toBe(0);
    expect(events).toEqual([]);
    const ada = auth0.users.get("auth0|ada");
    expect(ada?.yuu).toBeUndefined();
    expect(ada?.orders).toEqual([{ id: "order-1" }]);
    expect(ada?.cart).toEqual({ items: [] });
    expect(auth0.users.get("auth0|ben")?.orders).toEqual([{ id: "order-2" }]);
    expect(auth0.patches).toEqual([{ userId: "auth0|ada", patch: { yuu: null } }]);
    expect(queries).toContain("delete from yuu_transactions");
    expect(queries).toContain("delete from yuu_signals");
    expect(queries).toContain("delete from yuu_members");
  });
});

describe("stores, webhook and transaction rows", () => {
  it("records a store and a basket, and defaults an older purchase to the Pelita store", async () => {
    getShopper.mockResolvedValue({ id: "auth0|ada", name: "Ada Lovelace" });
    const stored = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", {
      sku: "PL-80014",
      qty: 1,
      channel: "partner",
      storeId: "harbour-mart",
    }));
    expect(stored.status).toBe(200);
    const yuu = auth0.users.get("auth0|ada")?.yuu as { purchases: { store: string; basket: string }[] };
    expect(yuu.purchases[0]?.store).toBe("harbour-mart");
    expect(yuu.purchases[0]?.basket).toMatch(/^[a-f0-9]{16}$/);
    const unknown = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", storeId: "not-a-store" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown_store" });

    const at = new Date().toISOString();
    auth0.users.set("auth0|old", {
      yuu: { points: 32, purchases: [{ sku: "PL-20055", name: "Magnesium Glycinate 400 mg", qty: 1, cents: 3290, points: 32, at }] },
    });
    const rows = await transactionsRoute(bearer("https://x.test/api/bi/loyalty/transactions?window_minutes=60"));
    expect(rows.status).toBe(200);
    const body = await rows.json();
    const legacy = body.rows.find((row: { member_key: string }) => row.member_key === hashShopperId("auth0|old"));
    expect(legacy).toMatchObject({ store_id: YUU_DEFAULT_STORE_ID, sku: "PL-20055", channel: "web", basket_id: expect.stringMatching(/^legacy-/) });
    expect(JSON.stringify(body)).not.toContain("auth0|");
    expect(body.rows.some((row: { store_id: string }) => row.store_id === "harbour-mart")).toBe(true);
    const aggregate = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty"));
    expect(await aggregate.json()).not.toHaveProperty("rows");
  });

  it("posts one escalation, signs the body, and does not post that escalation again", async () => {
    const posts: { body: string; authorization: string | null; hub: string | null; yuu: string | null }[] = [];
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      posts.push({
        body: String(init?.body),
        authorization: headers.get("authorization"),
        hub: headers.get("x-hub-signature-256"),
        yuu: headers.get("x-yuu-signature"),
      });
      return new Response("ok", { status: 202 });
    }));
    process.env.YUU_SIGNAL_WEBHOOK_URL = "https://hooks.example/yuu?token=do-not-log";
    process.env.YUU_SIGNAL_WEBHOOK_SECRET = "webhook-secret-value";
    process.env.APP_BASE_URL = "https://koffee-bean.vercel.app";
    const sku = loadScenario().proposal.productId;
    for (const user of ["auth0|ada", "auth0|ben"]) {
      expect((await buyAs(user, sku)).status).toBe(200);
      expect((await buyAs(user, sku, 1, "partner")).status).toBe(200);
    }
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0]?.body ?? "{}");
    expect(payload).toMatchObject({
      type: "yuu.signal.escalated",
      label: "yuu (simulated)",
      sku,
      repeat_members: 2,
      distinct_members: 2,
      score: 4,
      scan_complete: true,
      links: {
        ops: "https://koffee-bean.vercel.app/pelita/ops",
        loyalty_api: "https://koffee-bean.vercel.app/api/bi/loyalty",
      },
    });
    expect(payload.signal_id).toEqual(expect.any(String));
    expect(payload.stores).toEqual([{ store_id: "pelita-sg", qty: 4 }]);
    const signature = yuuWebhookSignature(posts[0]?.body ?? "", "webhook-secret-value");
    expect(posts[0]?.authorization).toBe("Bearer webhook-secret-value");
    expect(posts[0]?.hub).toBe(signature);
    expect(posts[0]?.yuu).toBe(signature);
    expect(posts[0]?.body).not.toContain("auth0|");
    expect(JSON.stringify(logged)).not.toContain("webhook-secret-value");
    expect(JSON.stringify(logged)).not.toContain("do-not-log");
    expect(logged.some((line) => line.includes(202))).toBe(true);

    const again = await detectRoute(demoPost("https://x.test/api/demo/pelita/yuu/detect"));
    expect(again.status).toBe(200);
    expect(posts).toHaveLength(1);
    const panel = await again.json();
    expect(panel.signals.find((signal: { sku: string }) => signal.sku === sku).webhook).toEqual({ status: "sent", code: 202 });
  });

  it("buckets purchases by hour for the monitoring feed", async () => {
    const at = new Date().toISOString();
    auth0.users.set("auth0|ada", {
      yuu: {
        points: 64,
        purchases: [
          { sku: "PL-20055", name: "Magnesium Glycinate 400 mg", qty: 1, cents: 3290, points: 32, at, store: "harbour-mart", channel: "partner", basket: "aaaa1111bbbb2222" },
          { sku: "PL-20055", name: "Magnesium Glycinate 400 mg", qty: 2, cents: 6580, points: 65, at, store: "ridge-pharmacy", channel: "partner", basket: "cccc3333dddd4444" },
        ],
      },
    });
    auth0.users.set("auth0|ben", {
      yuu: {
        points: 32,
        purchases: [{ sku: "PL-20055", name: "Magnesium Glycinate 400 mg", qty: 1, cents: 3290, points: 32, at, store: "harbour-mart", channel: "partner", basket: "eeee5555ffff6666" }],
      },
    });
    const open = await transactionsRoute(new Request("https://x.test/api/bi/loyalty/transactions?bucket=hour&days=7"));
    expect(open.status).toBe(401);
    const tooLong = await transactionsRoute(bearer("https://x.test/api/bi/loyalty/transactions?bucket=hour&days=31"));
    expect(tooLong.status).toBe(400);
    const res = await transactionsRoute(bearer("https://x.test/api/bi/loyalty/transactions?bucket=hour&days=7"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bucket).toBe("hour");
    expect(body.days).toBe(7);
    expect(body.buckets).toEqual([
      expect.objectContaining({
        sku: "PL-20055",
        qty: 4,
        purchases: 3,
        distinct_members: 2,
        stores: 2,
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("auth0|");
  });
});

describe("escalation window dedupe", () => {
  it("reuses one signal inside the window and mints a new signal_id after it elapses", async () => {
    const posts: { body: string; authorization: string | null; hub: string | null; yuu: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      posts.push({
        body: String(init?.body),
        authorization: headers.get("authorization"),
        hub: headers.get("x-hub-signature-256"),
        yuu: headers.get("x-yuu-signature"),
      });
      return new Response("ok", { status: 200 });
    }));
    process.env.YUU_SIGNAL_WEBHOOK_URL = "https://hooks.example/yuu";
    process.env.YUU_SIGNAL_WEBHOOK_SECRET = "webhook-secret-value";
    process.env.APP_BASE_URL = "https://koffee-bean.vercel.app";

    const sku = loadScenario().proposal.productId;
    const windowMinutes = 15;
    const first = new Date("2026-11-27T04:52:00+08:00");
    const inside = new Date(first.getTime() + (windowMinutes - 1) * 60_000);
    const elapsed = new Date(first.getTime() + windowMinutes * 60_000);
    for (const userId of ["auth0|ada", "auth0|ben"]) {
      auth0.users.set(userId, {
        yuu: { points: 64, purchases: [purchaseOf(first.toISOString(), sku), purchaseOf(first.toISOString(), sku)] },
      });
    }

    const opened = await runYuuDetector(windowMinutes, first, { awaitWebhook: true });
    expect(posts).toHaveLength(1);
    const firstPayload = JSON.parse(posts[0]?.body ?? "{}") as { signal_id: string; sku: string; window_minutes: number };
    expect(firstPayload).toMatchObject({ type: "yuu.signal.escalated", sku, window_minutes: windowMinutes, score: 4 });
    expect(firstPayload.signal_id).toBe(opened.find((signal) => signal.sku === sku)?.id);
    const signature = yuuWebhookSignature(posts[0]?.body ?? "", "webhook-secret-value");
    expect(posts[0]?.authorization).toBe("Bearer webhook-secret-value");
    expect(posts[0]?.hub).toBe(signature);
    expect(posts[0]?.yuu).toBe(signature);
    expect(posts[0]?.body).not.toContain("auth0|");

    const again = await runYuuDetector(windowMinutes, inside, { awaitWebhook: true });
    expect(posts).toHaveLength(1);
    expect(again.find((signal) => signal.sku === sku)?.id).toBe(firstPayload.signal_id);
    expect([...signals.values()].filter((signal) => signal.sku === sku && signal.status === "escalated")).toHaveLength(1);

    const renewed = await runYuuDetector(windowMinutes, elapsed, { awaitWebhook: true });
    expect(posts).toHaveLength(2);
    const secondPayload = JSON.parse(posts[1]?.body ?? "{}") as { signal_id: string };
    expect(secondPayload.signal_id).not.toBe(firstPayload.signal_id);
    expect(secondPayload.signal_id).toBe(renewed.find((signal) => signal.sku === sku)?.id);
    const secondSignature = yuuWebhookSignature(posts[1]?.body ?? "", "webhook-secret-value");
    expect(posts[1]?.authorization).toBe("Bearer webhook-secret-value");
    expect(posts[1]?.hub).toBe(secondSignature);
    expect(posts[1]?.yuu).toBe(secondSignature);
    expect(posts[1]?.body).not.toContain("auth0|");
    expect([...signals.values()].filter((signal) => signal.sku === sku && signal.status === "escalated")).toHaveLength(2);

    const report = await loyaltyRoute(bearer(`https://x.test/api/bi/loyalty?window_minutes=${windowMinutes}`));
    expect(report.status).toBe(200);
    const loyalty = await report.json();
    expect(loyalty.signals.find((signal: { sku: string }) => signal.sku === sku)).toMatchObject({
      id: secondPayload.signal_id,
      webhook: { status: "sent", code: 200 },
    });
    const panel = await readYuuPanel(windowMinutes);
    expect(panel.signals.find((signal) => signal.sku === sku)).toMatchObject({
      id: secondPayload.signal_id,
      webhook: { status: "sent", code: 200 },
    });
    expect(panel.signals.filter((signal) => signal.sku === sku)).toHaveLength(1);
  });
});

describe("route guards", () => {
  it("keeps demo writes same-origin and BI routes on the bearer secret", () => {
    const root = "src/app/api";
    for (const file of ["demo/pelita/yuu/purchase/route.ts", "demo/pelita/yuu/simulate/route.ts", "demo/pelita/yuu/detect/route.ts", "demo/pelita/reset/route.ts"]) {
      expect(readFileSync(`${root}/${file}`, "utf8")).toContain("guardDemoWrite(req)");
    }
    for (const file of ["bi/loyalty/route.ts", "bi/loyalty/signal/route.ts", "bi/loyalty/detect/route.ts", "bi/loyalty/transactions/route.ts"]) {
      expect(readFileSync(`${root}/${file}`, "utf8")).toContain("requireBiSecret(req)");
    }
  });
});
