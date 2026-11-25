import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashShopperId } from "@/lib/bi-hash";
import { POST as purchaseRoute } from "@/app/api/demo/pelita/yuu/purchase/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { POST as simulateRoute } from "@/app/api/demo/pelita/yuu/simulate/route";
import { GET as loyaltyRoute } from "@/app/api/bi/loyalty/route";
import { POST as signalRoute } from "@/app/api/bi/loyalty/signal/route";
import { getDemoState } from "@/lib/demo/state";
import { loadScenario } from "@/lib/demo/scenario";
import { burstLines, burstPurchases } from "@/lib/yuu/simulate";
import { classifyPurchases, yuuSkuBlocked, YUU_REASON, type LoyaltyPurchase } from "@/lib/yuu/detector";
import { tierForPoints } from "@/lib/yuu/tier";
import { YUU_PERSONAS } from "@/lib/yuu/personas";
import { evalFenced } from "./helpers/fake-redis-eval";

const getShopper = vi.hoisted(() => vi.fn(async () => null as { id: string; name?: string } | null));
const neonMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/shopper", () => ({ getShopper }));
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

const SECRET = "test-bi-api-secret-0123456789";
const HASH = "test-bi-hash-secret-0123456789";
const APPROVAL = "test-approval-secret";

type Command = (string | number)[];
type Member = { id: string; display_name: string; points: number; auth0_sub: string | null; is_test: boolean };
type Txn = { member_id: string; sku: string; product_name: string; qty: number; amount_sgd: string; points_earned: number; channel: string };
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
};

let members: Map<string, Member>;
let txns: Txn[];
let signals: Map<string, Signal>;
let events: unknown[];
let queries: string[];
let store: Map<string, string | string[]>;
let dbCount = 0;

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function signalKey(sku: string, window: number, day: string): string {
  return `${sku}|${window}|${day}`;
}

function handle(text: string, params: unknown[] = []): unknown[] {
  const sql = flat(text);
  queries.push(sql);
  if (sql.startsWith("insert into yuu_members") && sql.includes("jsonb_to_recordset")) {
    const rows = JSON.parse(String(params[0])) as { id: string; display_name: string }[];
    for (const row of rows) {
      if (!members.has(row.id)) {
        members.set(row.id, { id: row.id, display_name: row.display_name, points: 0, auth0_sub: null, is_test: false });
      }
    }
    return [];
  }
  if (sql.startsWith("insert into yuu_members")) {
    const [id, name, sub] = params as [string, string, string];
    const existing = [...members.values()].find((member) => member.auth0_sub === sub);
    if (existing) return [existing];
    const member: Member = { id, display_name: name, points: 0, auth0_sub: sub, is_test: false };
    members.set(id, member);
    return [member];
  }
  if (sql.includes("from yuu_members where id =")) {
    const member = members.get(String(params[0]));
    return member ? [member] : [];
  }
  if (sql.includes("from yuu_members where auth0_sub")) {
    const member = [...members.values()].find((row) => row.auth0_sub === params[0]);
    return member ? [member] : [];
  }
  if (sql.startsWith("select points, is_test")) {
    return [...members.values()].map((member) => ({ points: member.points, is_test: member.is_test }));
  }
  if (sql.startsWith("select id, display_name, points, is_test")) {
    return [...members.values()].map((member) => ({
      id: member.id,
      display_name: member.display_name,
      points: member.points,
      is_test: member.is_test,
    }));
  }
  if (sql.startsWith("select to_char")) return [{ day: "2026-11-26" }];
  if (sql.startsWith("select") && sql.includes("from yuu_transactions")) {
    return txns.map((txn) => ({ ...txn, is_test: members.get(txn.member_id)?.is_test ?? false }));
  }
  if (sql.startsWith("insert into yuu_transactions")) {
    txns.push(...(JSON.parse(String(params[0])) as Txn[]));
    return [];
  }
  if (sql.startsWith("update yuu_members") && sql.includes("jsonb_to_recordset")) {
    const rows = JSON.parse(String(params[0])) as { id: string; points: number }[];
    for (const row of rows) {
      const member = members.get(row.id);
      if (member) member.points += row.points;
    }
    return [];
  }
  if (sql.startsWith("insert into bi_events")) {
    events.push(JSON.parse(String(params[0])));
    return [];
  }
  if (sql.startsWith("insert into yuu_signals")) {
    const rows = JSON.parse(String(params[0])) as Array<Omit<Signal, "id" | "source" | "proposal_ref"> & { window_day: string }>;
    for (const row of rows) {
      const key = signalKey(row.sku, row.window_minutes, row.window_day);
      const prev = signals.get(key);
      if (prev?.source === "bi_bot" && prev.proposal_ref) continue;
      signals.set(key, {
        id: prev?.id ?? String(signals.size + 1),
        sku: row.sku,
        product_name: row.product_name,
        score: row.score,
        window_minutes: row.window_minutes,
        distinct_members: row.distinct_members,
        total_qty: row.total_qty,
        status: prev?.source === "bi_bot" && prev.proposal_ref ? prev.status : row.status,
        reason: prev?.source === "bi_bot" && prev.proposal_ref ? prev.reason : row.reason,
        source: prev?.source === "bi_bot" ? "bi_bot" : "detector",
        proposal_ref: prev?.proposal_ref ?? null,
        window_day: row.window_day,
      });
    }
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
  if (sql.startsWith("select") && sql.includes("from yuu_signals") && sql.includes("where sku =")) {
    const [sku, window, day] = params as [string, number, string];
    const signal = signals.get(signalKey(sku, Number(window), day));
    return signal ? [signal] : [];
  }
  if (sql.startsWith("select") && sql.includes("from yuu_signals")) {
    return [...signals.values()].filter((signal) => signal.window_day === params[0]);
  }
  if (sql.startsWith("update yuu_signals")) {
    const [reason, proposalRef, sku, window, day] = params as [string, string, string, number, string];
    const signal = signals.get(signalKey(sku, Number(window), day));
    if (!signal || signal.proposal_ref || (signal.status !== "shortlisted" && signal.status !== "escalated")) return [];
    signal.source = "bi_bot";
    signal.reason = reason;
    signal.proposal_ref = proposalRef;
    return [signal];
  }
  if (sql === "delete from yuu_transactions") {
    txns = [];
    return [];
  }
  if (sql === "delete from yuu_signals") {
    signals.clear();
    return [];
  }
  if (sql.startsWith("update yuu_members set points = 0")) {
    const ids = new Set(params[0] as string[]);
    for (const member of members.values()) if (ids.has(member.id)) member.points = 0;
    return [];
  }
  if (sql.startsWith("delete from yuu_members")) {
    const ids = new Set(params[0] as string[]);
    for (const id of [...members.keys()]) if (!ids.has(id)) members.delete(id);
    return [];
  }
  if (sql.startsWith("delete from bi_events")) {
    events = [];
    return [];
  }
  throw new Error(`unhandled sql: ${sql.slice(0, 160)}`);
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

beforeEach(() => {
  members = new Map();
  txns = [];
  signals = new Map();
  events = [];
  queries = [];
  store = new Map();
  getShopper.mockReset();
  getShopper.mockResolvedValue(null);
  process.env.BI_HASH_SECRET = HASH;
  process.env.BI_API_SECRET = SECRET;
  openDemo();
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
});

describe("yuu tier and detector", () => {
  it("derives Member, Silver and Gold from points", () => {
    expect(tierForPoints(0)).toBe("Member");
    expect(tierForPoints(499)).toBe("Member");
    expect(tierForPoints(500)).toBe("Silver");
    expect(tierForPoints(1999)).toBe("Silver");
    expect(tierForPoints(2000)).toBe("Gold");
  });

  it("escalates the strong repeat trend and drops the two weak patterns for their own reasons", () => {
    const rows = burstPurchases().map((row) => buy({ sku: row.sku, memberId: row.memberId, qty: row.qty, amountCents: row.amountCents, productName: row.productName }));
    const decisions = classifyPurchases(rows, (sku) => yuuSkuBlocked(sku, false));
    const bySku = new Map(decisions.map((decision) => [decision.sku, decision]));
    const strong = loadScenario().proposal.productId;
    expect(bySku.get(strong)).toMatchObject({ status: "escalated", score: 36, distinctMembers: 6, repeatMembers: 6 });
    expect(bySku.get("PL-80014")).toMatchObject({ status: "dropped", reason: YUU_REASON.singleMemberBulk, distinctMembers: 1 });
    expect(bySku.get("PL-80027")).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold, distinctMembers: 2, score: 4 });
    expect(decisions.filter((decision) => decision.status === "escalated")).toHaveLength(1);
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
});

describe("migration 0004", () => {
  const sql = readFileSync("db/migrations/0004_yuu_loyalty.sql", "utf8");

  it("is idempotent and seeds the simulated personas", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS yuu_members");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS yuu_transactions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS yuu_signals");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).toContain("UNIQUE (sku, window_minutes, window_day)");
    expect(sql).toContain("CHECK (channel IN ('web', 'sim'))");
    expect(sql).toContain("CHECK (status IN ('dropped', 'shortlisted', 'escalated'))");
    expect(YUU_PERSONAS).toHaveLength(8);
    for (const persona of YUU_PERSONAS) {
      expect(sql).toContain(persona.id);
      expect(sql).toContain(persona.displayName);
      expect(persona.displayName).toContain("(simulated)");
    }
    const lines = burstLines();
    expect(lines.filter((line) => line.role === "strong").map((line) => line.memberId)).toHaveLength(6);
    expect(new Set(lines.filter((line) => line.role === "strong").map((line) => line.sku)).size).toBe(1);
  });
});

describe("purchase API", () => {
  it("records a persona purchase, points, a hashed bi event, and a detector row", async () => {
    const res = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", qty: 1, memberId: "sim-aisha-rahman" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      label: "yuu (simulated)",
      memberId: "sim-aisha-rahman",
      sku: "PL-80014",
      qty: 1,
      amountSgd: "11.90",
      pointsEarned: 11,
      points: 11,
      tier: "Member",
      channel: "web",
    });
    expect(events).toHaveLength(1);
    const recorded = JSON.stringify(events);
    expect(recorded).toContain(hashShopperId("yuu:sim-aisha-rahman"));
    expect(recorded).toContain('"channel":"web"');
    expect(recorded).not.toContain("Aisha");
    const signal = [...signals.values()].find((row) => row.sku === "PL-80014");
    expect(signal).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold });
    expect(queries.some((query) => query.startsWith("insert into yuu_transactions"))).toBe(true);
    expect(queries.some((query) => query.startsWith("update yuu_members"))).toBe(true);
  });

  it("maps a signed-in shopper by subject and does not put that subject on the bi event", async () => {
    getShopper.mockResolvedValue({ id: "auth0|ada", name: "Ada Lovelace" });
    const res = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", qty: 1, memberId: "sim-aisha-rahman" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memberId).toMatch(/^auth-[0-9a-f]{16}$/);
    expect(body.memberId).not.toBe("sim-aisha-rahman");
    expect(body.displayName).toBe("Ada Lovelace (simulated)");
    const linked = [...members.values()].find((member) => member.auth0_sub === "auth0|ada");
    expect(linked?.id).toBe(body.memberId);
    const recorded = JSON.stringify(events);
    expect(recorded).toContain(hashShopperId("auth0|ada"));
    expect(recorded).not.toContain("auth0|ada");
  });

  it("refuses a cross-site post, a closed gate, and a missing member", async () => {
    const cross = await purchaseRoute(new Request("https://x.test/api/demo/pelita/yuu/purchase", { method: "POST", body: "{}" }));
    expect(cross.status).toBe(403);
    delete process.env.KB_DEMO_TRACK;
    const closed = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", memberId: "sim-aisha-rahman" }));
    expect(closed.status).toBe(404);
    openDemo();
    const missing = await purchaseRoute(demoPost("https://x.test/api/demo/pelita/yuu/purchase", { sku: "PL-80014", qty: 1 }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "unknown_member" });
  });
});

describe("BI loyalty API", () => {
  it("is 401 without the bearer secret and 200 with it", async () => {
    const open = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty"));
    expect(open.status).toBe(401);
    const wrong = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty", { headers: { authorization: "Bearer wrong" } }));
    expect(wrong.status).toBe(401);
    delete process.env.BI_API_SECRET;
    const unconfigured = await loyaltyRoute(new Request("https://x.test/api/bi/loyalty"));
    expect(unconfigured.status).toBe(503);
    process.env.BI_API_SECRET = SECRET;
    const ok = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      label: "yuu (simulated)",
      windowMinutes: 60,
      members: { count: 0, tierMix: { Member: 0, Silver: 0, Gold: 0 } },
      transactions: { count: 0 },
      skus: [],
      signals: [],
    });
  });

  it("refuses a signal without the bearer secret", async () => {
    const res = await signalRoute(new Request("https://x.test/api/bi/loyalty/signal", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("burst, signal and reset", () => {
  beforeEach(() => {
    installRedis();
  });

  it("plants a strong escalated signal and files it as the approval-1 proposal once", async () => {
    const simulated = await simulateRoute(demoPost("https://x.test/api/demo/pelita/yuu/simulate"));
    expect(simulated.status).toBe(200);
    const panel = await simulated.json();
    const strongSku = loadScenario().proposal.productId;
    const strong = panel.signals.find((signal: { sku: string }) => signal.sku === strongSku);
    const bulk = panel.signals.find((signal: { sku: string }) => signal.sku === "PL-80014");
    const blip = panel.signals.find((signal: { sku: string }) => signal.sku === "PL-80027");
    expect(strong).toMatchObject({ status: "escalated", source: "detector", score: 36 });
    expect(bulk).toMatchObject({ status: "dropped", reason: YUU_REASON.singleMemberBulk });
    expect(blip).toMatchObject({ status: "dropped", reason: YUU_REASON.belowThreshold });
    expect(panel.members).toHaveLength(8);
    expect(panel.members.every((member: { displayName: string }) => member.displayName.includes("(simulated)"))).toBe(true);

    const report = await loyaltyRoute(bearer("https://x.test/api/bi/loyalty?window_minutes=60"));
    expect(report.status).toBe(200);
    const loyalty = await report.json();
    expect(loyalty.transactions.count).toBe(17);
    expect(loyalty.members.count).toBe(8);
    expect(loyalty.skus.find((row: { sku: string }) => row.sku === strongSku).score).toBe(36);

    const rationale = "Six simulated members are repeat-buying magnesium glycinate inside the hour.";
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

  it("clears yuu purchases and signals, zeros persona points, and leaves the demo at stage 0", async () => {
    members.set("sim-aisha-rahman", { id: "sim-aisha-rahman", display_name: "Aisha Rahman (simulated)", points: 64, auth0_sub: null, is_test: false });
    members.set("auth-aabbccddeeff0011", { id: "auth-aabbccddeeff0011", display_name: "Ada (simulated)", points: 10, auth0_sub: "auth0|ada", is_test: false });
    txns.push({ member_id: "sim-aisha-rahman", sku: "PL-20055", product_name: "Magnesium", qty: 1, amount_sgd: "32.90", points_earned: 32, channel: "sim" });
    signals.set("PL-20055|60|2026-11-26", {
      id: "1",
      sku: "PL-20055",
      product_name: "Magnesium",
      score: 36,
      window_minutes: 60,
      distinct_members: 6,
      total_qty: 12,
      status: "escalated",
      reason: "strongest repeat trend",
      source: "detector",
      proposal_ref: null,
      window_day: "2026-11-26",
    });
    events.push({ shopper_hash: "abc" });
    store.set("kb:demo:pelita:stage", "4");

    const res = await resetRoute(demoPost("https://x.test/api/demo/pelita/reset"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(txns).toEqual([]);
    expect(signals.size).toBe(0);
    expect(events).toEqual([]);
    expect(members.get("sim-aisha-rahman")?.points).toBe(0);
    expect(members.has("auth-aabbccddeeff0011")).toBe(false);
    expect(members.has("sim-aisha-rahman")).toBe(true);
  });
});

describe("route guards", () => {
  it("keeps demo writes same-origin and BI routes on the bearer secret", () => {
    const root = "src/app/api";
    for (const file of ["demo/pelita/yuu/purchase/route.ts", "demo/pelita/yuu/simulate/route.ts", "demo/pelita/yuu/detect/route.ts", "demo/pelita/reset/route.ts"]) {
      expect(readFileSync(`${root}/${file}`, "utf8")).toContain("guardDemoWrite(req)");
    }
    for (const file of ["bi/loyalty/route.ts", "bi/loyalty/signal/route.ts", "bi/loyalty/detect/route.ts"]) {
      expect(readFileSync(`${root}/${file}`, "utf8")).toContain("requireBiSecret(req)");
    }
  });
});
