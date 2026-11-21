import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

import { GET } from "@/app/api/bi/profiles/route";

const SECRET = "test-bi-api-secret-0123456789";
let dbCount = 0;

const hash = (n: number) => n.toString(16).padStart(64, "0");
const consentedRow = (n: number, overrides: Record<string, unknown> = {}) => ({
  shopper_hash: hash(n),
  segment: "repeat",
  cadence_days: 14,
  aov_cents: 2400,
  orders_90d: 3,
  preferred_roast: "medium",
  region: "23",
  marketing_consent: true,
  consent_at: new Date("2026-11-10T00:00:00.000Z"),
  updated_at: new Date("2026-11-20T00:00:00.000Z"),
  ...overrides,
});

type Canned = {
  rows: Record<string, unknown>[];
  excluded: number;
  regions: Record<string, unknown>[];
};

function install(canned: Partial<Canned> = {}) {
  const data: Canned = { rows: [consentedRow(1), consentedRow(2)], excluded: 4, regions: [{ region: "23", n: 7 }, { region: "10", n: 6 }], ...canned };
  queryMock.mockImplementation(async (text: string) => {
    if (text.includes("percentile_cont")) {
      return [{ shoppers: 12, consented: 3, avg_aov_cents: 2399.6, avg_orders_90d: 2.456, median_cadence_days: 14 }];
    }
    if (text.includes("GROUP BY segment")) return [{ segment: "repeat", n: 8 }, { segment: "new", n: 3 }, { segment: "lapsed", n: 1 }];
    if (text.includes("GROUP BY region")) return data.regions;
    if (text.includes("GROUP BY preferred_roast")) return [{ preferred_roast: "medium", n: 6 }, { preferred_roast: "light", n: 2 }];
    if (text.includes("COUNT(*)::int AS n FROM bi_customer_profiles WHERE is_test = true")) return [{ n: data.excluded }];
    if (text.includes("marketing_consent = true")) return data.rows;
    throw new Error(`unexpected query: ${text}`);
  });
}

function call(path = "/api/bi/profiles", headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return GET(new Request(`http://localhost${path}`, { headers }));
}

const sqlTexts = () => queryMock.mock.calls.map(([text]) => String(text));
const rowsCall = () => queryMock.mock.calls.find(([text]) => String(text).includes("marketing_consent = true"))!;

beforeEach(() => {
  process.env.BI_API_SECRET = SECRET;
  dbCount += 1;
  process.env.DATABASE_URL = `postgres://user:pw@profiles${dbCount}.example/neondb`;
  queryMock.mockReset();
  neonMock.mockReset();
  neonMock.mockReturnValue(Object.assign(vi.fn(), { query: queryMock }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.BI_API_SECRET;
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

describe("GET /api/bi/profiles auth and config", () => {
  it("is 401 for a missing, wrong or shopper-style credential and never queries", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { "x-bi-secret": "wrong" }, { cookie: "appSession=abc" }]) {
      const res = await call("/api/bi/profiles", headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(neonMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("accepts the secret as a bearer token or x-bi-secret", async () => {
    install();
    expect((await call("/api/bi/profiles", { "x-bi-secret": SECRET })).status).toBe(200);
    expect((await call()).status).toBe(200);
  });

  it("is 503 when the secret or the database is not configured, and never opens up", async () => {
    delete process.env.BI_API_SECRET;
    expect((await call()).status).toBe(503);
    process.env.BI_API_SECRET = SECRET;
    delete process.env.DATABASE_URL;
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "database_unconfigured" });
  });

  it("is 503 unavailable, with no detail, when Neon fails (for example 0003 is not applied)", async () => {
    queryMock.mockRejectedValue(new Error('relation "bi_customer_profiles" does not exist'));
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("GET /api/bi/profiles", () => {
  it("returns aggregates by default, excludes test rows, and reports excludedTest", async () => {
    install();
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      source: string;
      aggregates: Record<string, unknown>;
      rows: unknown[];
      excludedTest: number;
    };
    expect(body.source).toBe("live");
    expect(body.excludedTest).toBe(4);
    expect(body.aggregates).toEqual({
      shoppers: 12,
      marketingConsented: 3,
      segments: { prospect: 0, new: 3, repeat: 8, lapsed: 1 },
      regions: [
        { region: "23", shoppers: 7 },
        { region: "10", shoppers: 6 },
      ],
      preferredRoasts: { medium: 6, light: 2 },
      avgAovCents: 2400,
      avgOrders90d: 2.46,
      medianCadenceDays: 14,
    });
    for (const text of sqlTexts().filter((t) => !t.includes("is_test = true"))) expect(text).toContain("is_test = false");
  });

  it("lists per-hash rows only where marketing_consent is true", async () => {
    install();
    const body = (await (await call()).json()) as { rows: Record<string, unknown>[] };
    const [text] = rowsCall();
    expect(String(text)).toContain("marketing_consent = true");
    expect(String(text)).toContain("is_test = false");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      shopper_hash: hash(1),
      segment: "repeat",
      cadence_days: 14,
      aov_cents: 2400,
      orders_90d: 3,
      preferred_roast: "medium",
      region: "23",
      consent_at: "2026-11-10T00:00:00.000Z",
      updated_at: "2026-11-20T00:00:00.000Z",
    });
  });

  it("drops a non-consented row even if the database somehow returned one", async () => {
    install({ rows: [consentedRow(1), consentedRow(2, { marketing_consent: false }), consentedRow(3, { marketing_consent: null })] });
    const body = (await (await call()).json()) as { rows: { shopper_hash: string }[] };
    expect(body.rows.map((row) => row.shopper_hash)).toEqual([hash(1)]);
  });

  it("selects explicit columns, never *, and reads no postcode column", async () => {
    install();
    await call();
    for (const text of sqlTexts()) {
      expect(text).not.toMatch(/SELECT\s+\*/i);
      expect(text).not.toMatch(/postcode|email|name/i);
    }
  });

  it("returns only a 2-digit region, never a postcode, even if a stored value were malformed", async () => {
    install({
      rows: [consentedRow(1, { region: "238823" }), consentedRow(2, { region: "23 " }), consentedRow(3, { region: "68" })],
      regions: [{ region: "238823", n: 1 }, { region: "68", n: 6 }],
    });
    const raw = await (await call()).text();
    const body = JSON.parse(raw) as { aggregates: { regions: { region: string }[] }; rows: { region: string | null }[] };
    expect(body.rows.map((row) => row.region)).toEqual([null, null, "68"]);
    expect(body.aggregates.regions).toEqual([{ region: "68", shoppers: 6 }]);
    expect(raw).not.toContain("238823");
    expect(raw).not.toMatch(/postcode/i);
    expect(raw).not.toMatch(/"\d{6}"/);
  });

  it("filters by source (default live), binds it as a parameter, and rejects unknown sources", async () => {
    install();
    await call("/api/bi/profiles?source=demo");
    for (const [text, params] of queryMock.mock.calls) {
      expect(String(text)).toContain("source = $1");
      expect((params as unknown[])[0]).toBe("demo");
    }
    queryMock.mockClear();
    await call();
    expect((queryMock.mock.calls[0]![1] as unknown[])[0]).toBe("live");
    queryMock.mockClear();
    await call("/api/bi/profiles?source=all");
    for (const [text] of queryMock.mock.calls) expect(String(text)).not.toContain("source = $1");
    const bad = await call("/api/bi/profiles?source=%27%3B%20DROP%20TABLE");
    expect(bad.status).toBe(400);
  });

  it("pages consented rows by shopper_hash with limit and nextCursor", async () => {
    install({ rows: [consentedRow(1), consentedRow(2), consentedRow(3)] });
    const first = (await (await call("/api/bi/profiles?limit=2")).json()) as { rows: { shopper_hash: string }[]; nextCursor?: string };
    expect(first.rows.map((row) => row.shopper_hash)).toEqual([hash(1), hash(2)]);
    expect(first.nextCursor).toBe(hash(2));
    expect(rowsCall()[1]).toEqual(["live", 3]);

    queryMock.mockClear();
    install({ rows: [consentedRow(3)] });
    const second = (await (await call(`/api/bi/profiles?limit=2&cursor=${hash(2)}`)).json()) as { rows: unknown[]; nextCursor?: string };
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(String(rowsCall()[0])).toContain("shopper_hash > $2");
    expect(rowsCall()[1]).toEqual(["live", hash(2), 3]);
  });

  it("rejects a bad limit or cursor", async () => {
    install();
    for (const path of ["/api/bi/profiles?limit=0", "/api/bi/profiles?limit=abc", "/api/bi/profiles?limit=-1", "/api/bi/profiles?cursor=nope"]) {
      expect((await call(path)).status).toBe(400);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("caps the limit at 200", async () => {
    install();
    await call("/api/bi/profiles?limit=9999");
    expect(rowsCall()[1]).toEqual(["live", 201]);
  });
});
