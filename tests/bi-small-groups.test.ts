import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const neonMock = vi.hoisted(() => vi.fn());
vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));

import { GET } from "@/app/api/bi/profiles/route";
import { BI_MIN_GROUP_SIZE, OTHER_REGION, suppressRegions, type RegionCount } from "@/lib/bi-privacy";

const SECRET = "test-bi-api-secret-0123456789";
let dbCount = 0;

const counts = (...pairs: [string, number][]): RegionCount[] => pairs.map(([region, shoppers]) => ({ region, shoppers }));
const sum = (rows: readonly RegionCount[]) => rows.reduce((total, row) => total + row.shoppers, 0);

describe("BI_MIN_GROUP_SIZE", () => {
  it("is 5", () => {
    expect(BI_MIN_GROUP_SIZE).toBe(5);
  });
});

describe("suppressRegions: below, at and above the threshold", () => {
  it("hides a district of 4 inside other, and shows districts of 5 and 6", () => {
    const out = suppressRegions(counts(["10", 6], ["18", 5], ["23", 4], ["27", 3]));
    expect(out.regions).toEqual([
      { region: "10", shoppers: 6 },
      { region: "18", shoppers: 5 },
      { region: OTHER_REGION, shoppers: 7 },
    ]);
    expect([...out.visible].sort()).toEqual(["10", "18"]);
  });

  it("shows everything, and no other bucket, when every district is at least 5", () => {
    const out = suppressRegions(counts(["10", 5], ["18", 9]));
    expect(out.regions).toEqual([
      { region: "18", shoppers: 9 },
      { region: "10", shoppers: 5 },
    ]);
  });

  it("treats exactly 5 as shown and exactly 4 as hidden", () => {
    expect(suppressRegions(counts(["10", 5], ["18", 9])).visible.has("10")).toBe(true);
    expect(suppressRegions(counts(["10", 4], ["18", 9])).visible.has("10")).toBe(false);
  });

  it("publishes other alone when only small districts remain but they add up to the threshold", () => {
    expect(suppressRegions(counts(["10", 3], ["18", 2])).regions).toEqual([{ region: OTHER_REGION, shoppers: 5 }]);
  });

  it("publishes nothing when even all districts together are below the threshold", () => {
    const out = suppressRegions(counts(["10", 2], ["18", 2]));
    expect(out.regions).toEqual([]);
    expect(out.visible.size).toBe(0);
  });

  it("takes the minimum from its argument so the rule is one number", () => {
    expect(suppressRegions(counts(["10", 3], ["18", 3]), 3).regions.map((row) => row.region)).toEqual(["10", "18"]);
  });
});

describe("suppressRegions: a hidden count cannot be worked out from the totals", () => {
  it("folds the smallest shown district into other when the hidden ones alone are too few", () => {
    // 10:10 + 18:6 + 23:4 = 20. Hiding 23 alone would let `20 - (10 + 18)` give back exactly 4.
    const out = suppressRegions(counts(["10", 10], ["18", 6], ["23", 4]));
    expect(out.regions).toEqual([
      { region: "10", shoppers: 10 },
      { region: OTHER_REGION, shoppers: 10 },
    ]);
    const total = 20;
    const named = sum(out.regions.filter((row) => row.region !== OTHER_REGION));
    expect(total - named).toBe(10);
    expect(out.regions.some((row) => row.shoppers === 4)).toBe(false);
    expect(out.visible.has("18")).toBe(false);
  });

  it("never publishes a district under the threshold, and total minus named never exposes one", () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let run = 0; run < 400; run += 1) {
      const districts = 1 + (next() % 8);
      const input = Array.from({ length: districts }, (_, index) => ({ region: String(10 + index), shoppers: 1 + (next() % 12) }));
      const total = sum(input);
      if (total < BI_MIN_GROUP_SIZE) continue;
      const out = suppressRegions(input);
      const small = input.filter((row) => row.shoppers < BI_MIN_GROUP_SIZE);
      for (const row of out.regions) expect(row.shoppers).toBeGreaterThanOrEqual(BI_MIN_GROUP_SIZE);
      for (const row of small) expect(out.regions.some((shown) => shown.region === row.region)).toBe(false);
      const named = sum(out.regions.filter((row) => row.region !== OTHER_REGION));
      const left = total - named;
      expect(left === 0 || left >= BI_MIN_GROUP_SIZE).toBe(true);
      for (const row of small) expect(left).not.toBe(row.shoppers);
      expect(sum(out.regions)).toBe(total);
    }
  });
});

describe("GET /api/bi/profiles: small groups", () => {
  const hash = (n: number) => n.toString(16).padStart(64, "0");
  const consentedRow = (n: number, region: string) => ({
    shopper_hash: hash(n),
    segment: "repeat",
    cadence_days: 14,
    aov_cents: 2400,
    orders_90d: 3,
    preferred_roast: "medium",
    region,
    marketing_consent: true,
    consent_at: new Date("2026-11-10T00:00:00.000Z"),
    updated_at: new Date("2026-11-20T00:00:00.000Z"),
  });

  function install(regionCounts: [string, number][], rows: ReturnType<typeof consentedRow>[] = []) {
    const total = regionCounts.reduce((sumSoFar, [, n]) => sumSoFar + n, 0);
    queryMock.mockImplementation(async (text: string) => {
      if (text.includes("percentile_cont")) return [{ shoppers: total, consented: rows.length, avg_aov_cents: 2400, avg_orders_90d: 2, median_cadence_days: 14 }];
      if (text.includes("GROUP BY segment")) return [{ segment: "repeat", n: total }];
      if (text.includes("GROUP BY region")) return regionCounts.map(([region, n]) => ({ region, n }));
      if (text.includes("GROUP BY preferred_roast")) return [];
      if (text.includes("is_test = true")) return [{ n: 0 }];
      if (text.includes("marketing_consent = true")) return rows;
      throw new Error(`unexpected query: ${text}`);
    });
  }

  type Body = { aggregates: { shoppers: number; regions: RegionCount[] }; rows: { region: string | null }[] };
  const call = async () => (await (await GET(new Request("http://localhost/api/bi/profiles", { headers: { authorization: `Bearer ${SECRET}` } }))).json()) as Body;

  beforeEach(() => {
    process.env.BI_API_SECRET = SECRET;
    dbCount += 1;
    process.env.DATABASE_URL = `postgres://user:pw@groups${dbCount}.example/neondb`;
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

  it("shows a district of 5 or 6, and puts a district of 4 into other", async () => {
    install([["10", 6], ["18", 5], ["23", 4], ["27", 4]]);
    const body = await call();
    expect(body.aggregates.regions).toEqual([
      { region: "10", shoppers: 6 },
      { region: "18", shoppers: 5 },
      { region: "other", shoppers: 8 },
    ]);
  });

  it("does not let total minus the named districts give back a hidden district", async () => {
    install([["10", 10], ["18", 6], ["23", 4]]);
    const { aggregates } = await call();
    expect(aggregates.shoppers).toBe(20);
    const named = aggregates.regions.filter((row) => row.region !== "other");
    const other = aggregates.regions.find((row) => row.region === "other");
    expect(other?.shoppers).toBe(10);
    expect(aggregates.shoppers - sum(named)).toBe(other?.shoppers);
    expect(JSON.stringify(aggregates.regions)).not.toContain('"23"');
    expect(aggregates.regions.every((row) => row.shoppers >= BI_MIN_GROUP_SIZE)).toBe(true);
  });

  it("drops the region from a per-shopper row in a hidden district, and keeps it in a shown one", async () => {
    install([["10", 9], ["23", 3], ["27", 3]], [consentedRow(1, "10"), consentedRow(2, "23")]);
    const body = await call();
    expect(body.rows.map((row) => row.region)).toEqual(["10", null]);
  });

  it("applies to source=demo and source=all the same way", async () => {
    install([["10", 2], ["18", 2], ["23", 2]]);
    for (const source of ["demo", "all"]) {
      const res = await GET(new Request(`http://localhost/api/bi/profiles?source=${source}`, { headers: { authorization: `Bearer ${SECRET}` } }));
      const body = (await res.json()) as Body;
      expect(body.aggregates.regions).toEqual([{ region: "other", shoppers: 6 }]);
    }
  });
});
