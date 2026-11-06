import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

import { GET as getEvents } from "@/app/api/bi/events/route";
import { GET as getSummary } from "@/app/api/bi/summary/route";

const SECRET = "test-bi-api-secret-0123456789";
let dbCount = 0;

function call(handler: (req: Request) => Promise<Response>, path: string, headers: Record<string, string> = {}) {
  return handler(new Request(`http://localhost${path}`, { headers }));
}
const authed = { authorization: `Bearer ${SECRET}` };

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(id),
    created_at: new Date(Date.UTC(2026, 10, 1, 12, 0, id)),
    event_type: "order.placed",
    source: "live",
    shopper_hash: "a".repeat(64),
    session_id: null,
    payload: { orderId: `o${id}`, totalCents: 1000 },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.BI_API_SECRET = SECRET;
  dbCount += 1;
  process.env.DATABASE_URL = `postgres://user:pw@db${dbCount}.example/neondb`;
  queryMock.mockReset();
  neonMock.mockReset();
  neonMock.mockReturnValue(Object.assign(vi.fn(), { query: queryMock }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BI_API_SECRET;
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each([
  ["events", getEvents, "/api/bi/events"],
  ["summary", getSummary, "/api/bi/summary"],
] as const)("GET %s auth and config", (_name, handler, path) => {
  it("returns 401 for a missing, wrong, or shopper-style credential and never queries", async () => {
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
      { authorization: SECRET },
      { "x-bi-secret": "wrong" },
      { cookie: "appSession=abc" },
    ];
    for (const headers of attempts) {
      const res = await call(handler, path, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(queryMock).not.toHaveBeenCalled();
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("accepts the secret as a bearer token or x-bi-secret", async () => {
    queryMock.mockResolvedValue([]);
    expect((await call(handler, path, authed)).status).toBe(200);
    expect((await call(handler, path, { "x-bi-secret": SECRET })).status).toBe(200);
  });

  it("returns 503 when BI_API_SECRET is unset, even with a header", async () => {
    delete process.env.BI_API_SECRET;
    const res = await call(handler, path, { authorization: "Bearer " });
    expect(res.status).toBe(503);
    expect((await call(handler, path, { "x-bi-secret": "" })).status).toBe(503);
  });

  it("returns 503 when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const res = await call(handler, path, authed);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "database_unconfigured" });
    expect(neonMock).not.toHaveBeenCalled();
  });

  it("returns 503 when Neon fails, without leaking the error", async () => {
    queryMock.mockRejectedValue(new Error("connection to postgres://user:pw@host failed"));
    const res = await call(handler, path, authed);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("postgres://");
  });

  it("is not cacheable", async () => {
    queryMock.mockResolvedValue([]);
    expect((await call(handler, path, authed)).headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("GET /api/bi/events", () => {
  it("defaults to live only, newest first, with the default limit", async () => {
    queryMock.mockResolvedValue([row(2), row(1)]);
    const res = await call(getEvents, "/api/bi/events", authed);
    expect(res.status).toBe(200);
    const [text, values] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("source = $1");
    expect(text).toContain("ORDER BY id DESC");
    expect(values).toEqual(["live", 51]);
    const body = await res.json();
    expect(body.nextCursor).toBeUndefined();
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual({
      id: "2",
      created_at: "2026-11-01T12:00:02.000Z",
      event_type: "order.placed",
      source: "live",
      shopper_hash: "a".repeat(64),
      session_id: null,
      payload: { orderId: "o2", totalCents: 1000 },
    });
  });

  it("selects only safe columns", async () => {
    queryMock.mockResolvedValue([]);
    await call(getEvents, "/api/bi/events", authed);
    const text = (queryMock.mock.calls[0] as [string])[0];
    expect(text).toContain("SELECT id, created_at, event_type, source, shopper_hash, session_id, payload");
    expect(text).not.toMatch(/\bsub\b|SELECT \*/i);
  });

  it("only returns known columns even if a row carries extras", async () => {
    queryMock.mockResolvedValue([row(1, { sub: "auth0|secret", chat_text: "hello" })]);
    const body = await (await call(getEvents, "/api/bi/events", authed)).json();
    expect(Object.keys(body.events[0]).sort()).toEqual(
      ["created_at", "event_type", "id", "payload", "session_id", "shopper_hash", "source"],
    );
  });

  it("supports source=demo and source=all", async () => {
    queryMock.mockResolvedValue([]);
    await call(getEvents, "/api/bi/events?source=demo", authed);
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual(["demo", 51]);

    await call(getEvents, "/api/bi/events?source=all", authed);
    const [text, values] = queryMock.mock.calls[1] as [string, unknown[]];
    expect(text).not.toContain("source =");
    expect(values).toEqual([51]);
  });

  it("filters by window, repeated and comma event_type, and cursor", async () => {
    queryMock.mockResolvedValue([]);
    const url =
      "/api/bi/events?since=2026-11-01T00:00:00Z&until=2026-11-02T00:00:00Z" +
      "&event_type=order.placed,order.cancelled&event_type=barista.turn&event_type=order.placed&cursor=90&limit=10";
    expect((await call(getEvents, url, authed)).status).toBe(200);
    const [text, values] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("created_at >= $1::timestamptz");
    expect(text).toContain("created_at < $2::timestamptz");
    expect(text).toContain("event_type = ANY($4::text[])");
    expect(text).toContain("id < $5::bigint");
    expect(values).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
      "live",
      ["order.placed", "order.cancelled", "barista.turn"],
      "90",
      11,
    ]);
  });

  it("accepts after_id as an alias for cursor", async () => {
    queryMock.mockResolvedValue([]);
    await call(getEvents, "/api/bi/events?after_id=42", authed);
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual(["live", "42", 51]);
  });

  it("caps limit at 200", async () => {
    queryMock.mockResolvedValue([]);
    await call(getEvents, "/api/bi/events?limit=100000", authed);
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual(["live", 201]);
  });

  it("returns nextCursor only when more rows exist", async () => {
    queryMock.mockResolvedValue([row(5), row(4), row(3)]);
    const body = await (await call(getEvents, "/api/bi/events?limit=2", authed)).json();
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["5", "4"]);
    expect(body.nextCursor).toBe("4");

    queryMock.mockResolvedValue([row(5), row(4)]);
    const last = await (await call(getEvents, "/api/bi/events?limit=2", authed)).json();
    expect(last.events).toHaveLength(2);
    expect("nextCursor" in last).toBe(false);
  });

  it.each([
    "since=yesterday",
    "until=not-a-date",
    "since=2026-11-02T00:00:00Z&until=2026-11-01T00:00:00Z",
    "event_type=order.placed,nope",
    "source=everything",
    "limit=0",
    "limit=abc",
    "limit=-5",
    "cursor=1;DROP TABLE bi_events",
  ])("returns 400 for %s without querying", async (qs) => {
    const res = await call(getEvents, `/api/bi/events?${qs}`, authed);
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("never interpolates user input into the SQL text", async () => {
    queryMock.mockResolvedValue([]);
    await call(getEvents, "/api/bi/events?event_type=order.placed&cursor=77&since=2026-11-01", authed);
    const text = (queryMock.mock.calls[0] as [string])[0];
    expect(text).not.toContain("order.placed");
    expect(text).not.toContain("77");
    expect(text).not.toContain("2026");
  });
});

describe("GET /api/bi/summary", () => {
  function mockSummary() {
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes("GROUP BY event_type")) {
        return [
          { event_type: "order.placed", outcome: null, n: 4, recs: 0 },
          { event_type: "order.cancelled", outcome: null, n: 1, recs: 0 },
          { event_type: "barista.turn", outcome: "replied", n: 10, recs: 0 },
          { event_type: "barista.turn", outcome: "timeout", n: 2, recs: 0 },
          { event_type: "recommend.shown", outcome: null, n: 8, recs: 8 },
          { event_type: "recommend.added", outcome: null, n: 3, recs: 2 },
        ];
      }
      if (text.includes("jsonb_array_elements")) {
        return [
          { product_id: "kb001", qty: 5, orders: 3 },
          { product_id: "kb005", qty: 2, orders: 2 },
        ];
      }
      if (text.includes("AS code")) return [{ code: "WELCOME10", orders: 2 }];
      return [{ orders: "4", revenue_cents: "10001", with_coupon: 2 }];
    });
  }

  it("aggregates the last 7 days, live only, by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
    mockSummary();
    const res = await call(getSummary, "/api/bi/summary", authed);
    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [text, values] of queryMock.mock.calls as [string, unknown[]][]) {
      expect(text).toContain("source = $3");
      expect(values).toEqual(["2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z", "live"]);
    }
    expect(await res.json()).toEqual({
      window: { since: "2026-11-01T00:00:00.000Z", until: "2026-11-08T00:00:00.000Z", source: "live" },
      orders: { placed: 4, cancelled: 1, revenueCents: 10001, aovCents: 2500, withCoupon: 2 },
      topSkus: [
        { productId: "kb001", qty: 5, orders: 3 },
        { productId: "kb005", qty: 2, orders: 2 },
      ],
      coupons: [{ code: "WELCOME10", orders: 2 }],
      recommendations: {
        shown: 8,
        added: 3,
        undone: 0,
        shownRecommendations: 8,
        addedRecommendations: 2,
        conversion: 0.25,
      },
      baristaTurns: { total: 12, byOutcome: { replied: 10, timeout: 2 } },
    });
  });

  it("returns zeros and null ratios for an empty window", async () => {
    queryMock.mockResolvedValue([]);
    const body = await (await call(getSummary, "/api/bi/summary", authed)).json();
    expect(body.orders).toEqual({ placed: 0, cancelled: 0, revenueCents: 0, aovCents: null, withCoupon: 0 });
    expect(body.recommendations.conversion).toBeNull();
    expect(body.topSkus).toEqual([]);
    expect(body.baristaTurns).toEqual({ total: 0, byOutcome: {} });
  });

  it("honours since, until, and source=all", async () => {
    queryMock.mockResolvedValue([]);
    const res = await call(
      getSummary,
      "/api/bi/summary?since=2026-10-01&until=2026-10-08T00:00:00Z&source=all",
      authed,
    );
    expect(res.status).toBe(200);
    for (const [text, values] of queryMock.mock.calls as [string, unknown[]][]) {
      expect(text).not.toContain("source =");
      expect(values).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z"]);
    }
  });

  it.each(["since=bad", "source=nope", "since=2026-11-02&until=2026-11-01"])(
    "returns 400 for %s",
    async (qs) => {
      expect((await call(getSummary, `/api/bi/summary?${qs}`, authed)).status).toBe(400);
      expect(queryMock).not.toHaveBeenCalled();
    },
  );
});
