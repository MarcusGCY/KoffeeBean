import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
const queryMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: recordMock,
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => true, getBiSql: () => sqlMock }));
vi.mock("@/lib/upstash", () => ({ redisPipeline: async () => [null] }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

import { buildDemoProfiles, buildDemoStory, seedBiDemoProfiles } from "@/lib/bi-demo-seed";
import { hashShopperId } from "@/lib/bi-hash";
import {
  BI_SEGMENTS,
  biProfileSchema,
  buildBiProfileFacts,
  segmentFor,
  upsertBiProfile,
  type BiProfileFacts,
} from "@/lib/bi-profiles";
import { trackOrderCancelled, trackOrderPlaced, trackProfile, type PlacedOrder } from "@/lib/bi-track";
import { emitBiProfile, placeOrder, cancelOrder } from "@/lib/store-meta";
import { emptyProfile } from "@/lib/barista-profile";

const SUB = "auth0|65f1c0ffee00112233445566";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const none = { consent: false, at: null };

const base = {
  orders: [] as { createdAt: string; cancelledAt?: string | null; totalCents: number }[],
  profile: null,
  region: null,
  marketing: none,
  isTest: false,
  now: NOW,
};

const PLACED: PlacedOrder = {
  id: "BB-ABC234",
  createdAt: NOW.toISOString(),
  subtotalCents: 1800,
  discountCents: 0,
  taxCents: 0,
  totalCents: 1800,
  coupon: null,
  items: [{ productId: "ethiopia-250", qty: 1, unitPriceCents: 1800 }],
};

function profileCalls() {
  return sqlMock.mock.calls.filter(([strings]) => Array.isArray(strings) && strings.join("").includes("bi_customer_profiles"));
}

function valuesOf(call: unknown[]): unknown[] {
  return call.slice(1);
}

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  delete process.env.DEMO_SHOPPER_SUB;
  db.meta = {};
  sqlMock.mockReset().mockResolvedValue([]);
  queryMock.mockReset().mockResolvedValue([]);
  recordMock.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("buildBiProfileFacts", () => {
  it("segments by lifetime orders and orders in the last 90 days", () => {
    expect(BI_SEGMENTS).toEqual(["prospect", "new", "repeat", "lapsed"]);
    expect(segmentFor(0, 0)).toBe("prospect");
    expect(segmentFor(1, 1)).toBe("new");
    expect(segmentFor(3, 1)).toBe("repeat");
    expect(segmentFor(3, 0)).toBe("lapsed");
  });

  it("counts non-cancelled orders and averages the last 90 days only", () => {
    const facts = buildBiProfileFacts({
      ...base,
      orders: [
        { createdAt: ago(5), totalCents: 2000 },
        { createdAt: ago(30), totalCents: 1000 },
        { createdAt: ago(40), totalCents: 99_999, cancelledAt: ago(40) },
        { createdAt: ago(200), totalCents: 5000 },
        { createdAt: "not a date", totalCents: 5000 },
      ],
    });
    expect(facts).toMatchObject({ segment: "repeat", orders90d: 2, aovCents: 1500 });
  });

  it("is a prospect with no orders, and lapsed when none are recent", () => {
    expect(buildBiProfileFacts(base)).toMatchObject({ segment: "prospect", orders90d: 0, aovCents: null });
    expect(buildBiProfileFacts({ ...base, orders: [{ createdAt: ago(120), totalCents: 900 }] })).toMatchObject({
      segment: "lapsed",
      orders90d: 0,
      aovCents: null,
    });
  });

  it("takes cadence and roast from the profile, and drops them when personalization is off", () => {
    const profile = { ...emptyProfile(NOW), cadenceDays: 14, preferredRoast: "dark" as const };
    expect(buildBiProfileFacts({ ...base, profile })).toMatchObject({ cadenceDays: 14, preferredRoast: "dark" });
    expect(buildBiProfileFacts({ ...base, profile: { ...profile, off: true } })).toMatchObject({
      cadenceDays: null,
      preferredRoast: null,
    });
  });

  it("mirrors marketing consent only when there is a consent time", () => {
    const at = ago(2);
    expect(buildBiProfileFacts({ ...base, marketing: { consent: true, at } })).toMatchObject({ marketingConsent: true, consentAt: at });
    expect(buildBiProfileFacts({ ...base, marketing: { consent: true, at: null } })).toMatchObject({ marketingConsent: false, consentAt: null });
    expect(buildBiProfileFacts({ ...base, marketing: { consent: false, at } })).toMatchObject({ marketingConsent: false, consentAt: null });
  });
});

describe("biProfileSchema: only a 2-digit region reaches BI", () => {
  const good: BiProfileFacts = { ...buildBiProfileFacts(base), region: "23" };

  it("accepts a 2-digit region or none", () => {
    expect(biProfileSchema.safeParse(good).success).toBe(true);
    expect(biProfileSchema.safeParse({ ...good, region: null }).success).toBe(true);
  });

  it("rejects a postcode, a 1- or 3-digit region, letters and unknown fields", () => {
    for (const region of ["238823", "2", "238", "ab", " 23", "23 "]) {
      expect(biProfileSchema.safeParse({ ...good, region }).success).toBe(false);
    }
    expect(biProfileSchema.safeParse({ ...good, postcode: "238823" }).success).toBe(false);
    expect(biProfileSchema.safeParse({ ...good, email: "a@example.com" }).success).toBe(false);
  });

  it("requires consent_at exactly when marketing_consent is true", () => {
    expect(biProfileSchema.safeParse({ ...good, marketingConsent: true, consentAt: null }).success).toBe(false);
    expect(biProfileSchema.safeParse({ ...good, marketingConsent: false, consentAt: ago(1) }).success).toBe(false);
  });
});

describe("upsertBiProfile", () => {
  it("writes one INSERT ... ON CONFLICT (shopper_hash) with the hash, never the sub", async () => {
    const facts: BiProfileFacts = { ...buildBiProfileFacts({ ...base, orders: [{ createdAt: ago(3), totalCents: 1800 }] }), region: "23", isTest: true };
    await upsertBiProfile(sqlMock as never, SUB, "live", facts, NOW);
    expect(sqlMock).toHaveBeenCalledOnce();
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    const text = (strings as string[]).join("?");
    expect(text).toContain("INSERT INTO bi_customer_profiles");
    expect(text).toContain("ON CONFLICT (shopper_hash) DO UPDATE");
    expect(values).toEqual([hashShopperId(SUB), "new", null, 1800, 1, null, "23", true, false, null, "live", NOW.toISOString()]);
    expect(JSON.stringify(sqlMock.mock.calls)).not.toContain(SUB);
  });

  it("writes nothing when a fact is invalid, such as a postcode in region", async () => {
    const bad = { ...buildBiProfileFacts(base), region: "238823" };
    await expect(upsertBiProfile(sqlMock as never, SUB, "live", bad, NOW)).rejects.toThrow();
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("bi-track hook", () => {
  const facts: BiProfileFacts = { ...buildBiProfileFacts(base), region: "23", segment: "new", orders90d: 1, aovCents: 1800 };

  it("refreshes the profile row after an order is placed or cancelled, when facts are supplied", async () => {
    await trackOrderPlaced({ sub: SUB, profile: facts }, PLACED);
    expect(profileCalls()).toHaveLength(1);
    await trackOrderCancelled({ sub: SUB, profile: facts }, { id: PLACED.id, totalCents: 1800, cancelledAt: NOW.toISOString() });
    expect(profileCalls()).toHaveLength(2);
  });

  it("leaves the profile table alone when no facts are supplied", async () => {
    await trackOrderPlaced({ sub: SUB }, PLACED);
    await trackOrderCancelled({ sub: SUB }, { id: PLACED.id, totalCents: 1800, cancelledAt: NOW.toISOString() });
    expect(profileCalls()).toHaveLength(0);
  });

  it("uses the demo source for a demo context and swallows a database failure", async () => {
    await trackProfile({ sub: SUB, source: "demo" }, facts);
    expect(valuesOf(profileCalls()[0]!).at(-2)).toBe("demo");
    sqlMock.mockRejectedValue(new Error("relation does not exist"));
    await expect(trackProfile({ sub: SUB }, facts)).resolves.toBeUndefined();
  });
});

describe("store-meta: placing and cancelling an order", () => {
  const cart = { items: [{ productId: "ethiopia-250", qty: 2 }], coupon: null };

  it("mirrors the profile with the 2-digit region only", async () => {
    db.meta = {
      cart,
      location: { postcode: "238823", consentAt: ago(10), purpose: "area-personalisation" },
    };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    const values = valuesOf(profileCalls()[0]!);
    expect(values).toEqual([hashShopperId(SUB), "new", null, 3888, 1, "light", "23", false, false, null, "live", expect.any(String)]);
    const everything = JSON.stringify(sqlMock.mock.calls);
    expect(everything).not.toContain("238823");
    expect(everything).not.toContain(SUB);
  });

  it("flags a shopper with is_test using the single isTestShopper check", async () => {
    db.meta = { cart, is_test: true };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    expect(valuesOf(profileCalls()[0]!)[7]).toBe(true);
  });

  it("flags the configured demo shopper, and not an is_test string", async () => {
    process.env.DEMO_SHOPPER_SUB = SUB;
    db.meta = { cart };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    expect(valuesOf(profileCalls()[0]!)[7]).toBe(true);

    sqlMock.mockClear();
    delete process.env.DEMO_SHOPPER_SUB;
    db.meta = { cart, is_test: "true" };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    expect(valuesOf(profileCalls()[0]!)[7]).toBe(false);
  });

  it("leaves taste traits out when personalization is off", async () => {
    db.meta = { cart, barista_profile: { ...emptyProfile(NOW), off: true } };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    const values = valuesOf(profileCalls()[0]!);
    expect(values[2]).toBeNull();
    expect(values[5]).toBeNull();
    expect(values[1]).toBe("new");
  });

  it("drops the order from the profile when it is cancelled", async () => {
    db.meta = { cart };
    const placed = (await placeOrder(SUB, NOW)) as { id: string };
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    sqlMock.mockClear();
    await cancelOrder(SUB, placed.id, new Date(NOW.getTime() + 60_000));
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    const values = valuesOf(profileCalls()[0]!);
    expect(values[1]).toBe("prospect");
    expect(values[4]).toBe(0);
  });

  it("emitBiProfile refreshes the row for a shopper with a location and no orders", async () => {
    db.meta = { location: { postcode: "680123", consentAt: ago(1), purpose: "area-personalisation" } };
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    expect(valuesOf(profileCalls()[0]!).slice(0, 8)).toEqual([hashShopperId(SUB), "prospect", null, null, 0, null, "68", false]);
    expect(JSON.stringify(sqlMock.mock.calls)).not.toContain("680123");
  });
});

describe("migration 0003_bi_customer_profiles.sql", () => {
  const sql = readFileSync("db/migrations/0003_bi_customer_profiles.sql", "utf8");

  it("defines the table with the requested columns and constraints", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bi_customer_profiles/);
    expect(sql).toMatch(/shopper_hash\s+TEXT\s+PRIMARY KEY/);
    for (const column of ["segment", "cadence_days", "aov_cents", "orders_90d", "preferred_roast", "region", "is_test", "marketing_consent", "consent_at", "source", "updated_at"]) {
      expect(sql).toMatch(new RegExp(`^\\s+${column}\\s`, "m"));
    }
    expect(sql).toContain("region ~ '^\\d{2}$'");
    expect(sql).toMatch(/CHECK \(NOT marketing_consent OR consent_at IS NOT NULL\)/);
  });

  it("has no postcode, email or name column", () => {
    const columns = sql.split("\n").filter((line) => /^\s{2}[a-z_0-9]+\s+(TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ)/.test(line));
    expect(columns.map((line) => line.trim().split(/\s+/)[0])).toEqual([
      "shopper_hash",
      "segment",
      "cadence_days",
      "aov_cents",
      "orders_90d",
      "preferred_roast",
      "region",
      "is_test",
      "marketing_consent",
      "consent_at",
      "source",
      "updated_at",
    ]);
  });

  it("is idempotent and says it is not applied by the app", () => {
    expect(sql).toMatch(/WRITTEN, NOT APPLIED/);
    expect(sql).not.toMatch(/DROP |TRUNCATE|DELETE FROM/i);
    expect(sql).toMatch(/IF NOT EXISTS bi_customer_profiles_source_test_idx/);
  });
});

describe("demo profile seed", () => {
  it("builds one valid, privacy-safe row per story shopper", () => {
    const rows = buildDemoProfiles(NOW);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.shopperHash)).size).toBe(6);
    for (const row of rows) {
      expect(row.shopperHash).toMatch(/^[0-9a-f]{64}$/);
      expect(biProfileSchema.safeParse(row.facts).success).toBe(true);
      expect(row.facts.region).toMatch(/^\d{2}$/);
    }
    expect(rows.filter((row) => row.facts.marketingConsent)).toHaveLength(3);
    expect(rows.filter((row) => row.facts.isTest)).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("demo-seed|");
    expect(buildDemoProfiles(NOW)).toEqual(rows);
  });

  it("matches the story's own orders", () => {
    const story = buildDemoStory(NOW);
    const first = buildDemoProfiles(NOW)[0]!;
    const mine = story.orders.filter((order) => order.shopperHash === first.shopperHash && !order.cancelledAt);
    expect(first.facts.orders90d).toBe(mine.length);
  });

  it("upserts as source demo in one statement that can only overwrite demo rows", async () => {
    const count = await seedBiDemoProfiles({ query: queryMock } as never, NOW);
    expect(count).toBe(6);
    expect(queryMock).toHaveBeenCalledOnce();
    const [text, params] = queryMock.mock.calls[0]!;
    expect(text).toContain("INSERT INTO bi_customer_profiles");
    expect(text).toContain("'demo'");
    expect(text).not.toContain("'live'");
    expect(text).toContain("WHERE bi_customer_profiles.source = 'demo'");
    expect(text).not.toMatch(/DELETE/i);
    const rows = JSON.parse(params[0] as string) as Record<string, unknown>[];
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => !("source" in row))).toBe(true);
  });
});
