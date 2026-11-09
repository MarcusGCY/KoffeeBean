import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAdminMock = vi.hoisted(() => vi.fn());
const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));
vi.mock("@/lib/demo-session", () => ({ readAdmin: readAdminMock }));

import { POST } from "@/app/api/demo/bi-seed/route";
import { biPayloadSchemas } from "@/lib/bi-events";
import { hashShopperId } from "@/lib/bi-hash";
import { buildDemoStory, seedBiDemoStory } from "@/lib/bi-demo-seed";
import { demoCsrfToken } from "@/lib/demo-auth";

let dbCount = 0;
const NOW = new Date("2026-11-06T12:00:00Z");

function fakeSql() {
  const calls: { text: string; params: unknown[] }[] = [];
  const transaction = vi.fn((fn: (txn: { query: (t: string, p: unknown[]) => unknown }) => unknown[]) => {
    fn({
      query: (text: string, params: unknown[]) => {
        calls.push({ text, params });
        return { queryData: { query: text, params } };
      },
    });
    return Promise.resolve([]);
  });
  return { sql: Object.assign(vi.fn(), { transaction, query: vi.fn() }), calls, transaction };
}

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
});

afterEach(() => {
  delete process.env.BI_HASH_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.APPROVAL_SECRET;
  vi.restoreAllMocks();
  readAdminMock.mockReset();
  neonMock.mockReset();
});

describe("buildDemoStory", () => {
  it("produces a cancellation spike with only valid, privacy-safe rows", () => {
    const story = buildDemoStory(NOW);
    for (const event of story.events) {
      expect(() => biPayloadSchemas[event.eventType as keyof typeof biPayloadSchemas].parse(event.payload)).not.toThrow();
      expect(event.shopperHash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sessionId).toMatch(/^demo-story:\d+$/);
      expect(event.createdAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
    const json = JSON.stringify(story);
    expect(json).not.toContain("demo-seed|");
    expect(json).not.toContain("auth0|");

    const placed = story.events.filter((e) => e.eventType === "order.placed");
    const cancelled = story.events.filter((e) => e.eventType === "order.cancelled");
    expect(placed).toHaveLength(27);
    expect(cancelled).toHaveLength(9);
    const spike = story.orders.filter((o) => o.coupon === "BEANS20");
    expect(spike).toHaveLength(12);
    expect(spike.filter((o) => o.cancelledAt).length).toBe(8);
    expect(story.orders.filter((o) => o.coupon !== "BEANS20" && o.cancelledAt)).toHaveLength(1);
    expect(story.orders).toHaveLength(placed.length);
  });

  it("hashes shoppers with hashShopperId and keeps the story deterministic for a fixed now", () => {
    const story = buildDemoStory(NOW);
    const hashes = new Set(story.orders.map((o) => o.shopperHash));
    expect(hashes.has(hashShopperId("demo-seed|shopper-1"))).toBe(true);
    expect(buildDemoStory(NOW)).toEqual(story);
  });

  it("throws when BI_HASH_SECRET is unset", () => {
    delete process.env.BI_HASH_SECRET;
    expect(() => buildDemoStory(NOW)).toThrow();
  });
});

describe("seedBiDemoStory", () => {
  it("emits source=demo and never a live row", async () => {
    const { sql, calls } = fakeSql();
    await seedBiDemoStory(sql as never, NOW);
    const inserts = calls.filter((call) => call.text.startsWith("INSERT"));
    expect(inserts).toHaveLength(2);
    for (const call of inserts) {
      expect(call.text).toContain("'demo'");
      expect(call.text).not.toContain("'live'");
    }
    const orders = JSON.parse(calls[3]!.params[0] as string) as { order_id: string }[];
    expect(orders.every((order) => order.order_id.startsWith("demo-story-"))).toBe(true);
    expect(orders.some((order) => order.order_id.startsWith("BB-"))).toBe(false);
  });

  it("replaces only demo-prefixed demo rows in one transaction", async () => {
    const { sql, calls, transaction } = fakeSql();
    const result = await seedBiDemoStory(sql as never, NOW);

    expect(transaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(4);
    const [delEvents, delOrders, insEvents, insOrders] = calls;
    expect(delEvents!.text).toMatch(/DELETE FROM bi_events WHERE source = 'demo' AND session_id LIKE/);
    expect(delEvents!.params).toEqual(["demo-story:%"]);
    expect(delOrders!.text).toMatch(/DELETE FROM bi_orders WHERE source = 'demo' AND order_id LIKE/);
    expect(delOrders!.params).toEqual(["demo-story-%"]);

    for (const call of calls) expect(call.text).not.toMatch(/'live'/);
    for (const call of [insEvents!, insOrders!]) expect(call.text).toMatch(/'demo'/);

    const events = JSON.parse(insEvents!.params[0] as string) as Record<string, unknown>[];
    const orders = JSON.parse(insOrders!.params[0] as string) as Record<string, unknown>[];
    expect(events).toHaveLength(result.events);
    expect(orders).toHaveLength(result.orders);
    expect(events.every((e) => !("source" in e))).toBe(true);
    expect(orders.every((o) => !("source" in o))).toBe(true);
    expect(events.every((e) => String(e.session_id).startsWith("demo-story:"))).toBe(true);
    expect(orders.every((o) => String(o.order_id).startsWith("demo-story-"))).toBe(true);
  });

  it("is re-runnable: a second seed issues the same delete-then-insert shape", async () => {
    const { sql, calls } = fakeSql();
    await seedBiDemoStory(sql as never, NOW);
    await seedBiDemoStory(sql as never, NOW);
    expect(calls).toHaveLength(8);
    expect(calls.slice(0, 4).map((c) => c.text)).toEqual(calls.slice(4).map((c) => c.text));
  });
});

describe("POST /api/demo/bi-seed", () => {
  const ADMIN = { id: "auth0|admin1", email: "owner@example.com" };

  function request(headers: Record<string, string>, csrf?: string) {
    return new Request("http://localhost/api/demo/bi-seed", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(csrf ? { csrf } : {}),
    });
  }

  beforeEach(() => {
    process.env.APPROVAL_SECRET = "test-approval-secret-0123456789";
    process.env.DATABASE_URL = `postgres://user:pw@seed${(dbCount += 1)}.example/neondb`;
  });

  it("is 404 without an admin session and writes nothing", async () => {
    readAdminMock.mockResolvedValue(null);
    const res = await POST(request({ origin: "http://localhost" }, "x"));
    expect(res.status).toBe(404);
  });

  it("rejects cross-site requests and bad CSRF tokens for an admin", async () => {
    readAdminMock.mockResolvedValue(ADMIN);
    expect((await POST(request({ origin: "http://evil.example" }, demoCsrfToken(ADMIN.id)))).status).toBe(403);
    expect((await POST(request({ origin: "http://localhost" }, "bad.token"))).status).toBe(403);
    expect((await POST(request({ origin: "http://localhost" }))).status).toBe(403);
  });

  it("seeds demo rows for an admin with a valid CSRF token", async () => {
    readAdminMock.mockResolvedValue(ADMIN);
    const { sql, calls } = fakeSql();
    neonMock.mockReturnValue(sql);
    const res = await POST(request({ origin: "http://localhost" }, demoCsrfToken(ADMIN.id)));
    const body = (await res.json()) as { flash: string; events: number; orders: number };
    expect(res.status).toBe(200);
    expect(body.flash).toBe("bi-seeded");
    expect(body.events).toBeGreaterThan(0);
    expect(calls).toHaveLength(4);
  });

  it("answers 503 when DATABASE_URL is unset", async () => {
    readAdminMock.mockResolvedValue(ADMIN);
    delete process.env.DATABASE_URL;
    const res = await POST(request({ origin: "http://localhost" }, demoCsrfToken(ADMIN.id)));
    expect(res.status).toBe(503);
  });
});
