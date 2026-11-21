import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => void task(),
}));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => true, getBiSql: () => sqlMock }));
vi.mock("@/lib/upstash", () => ({ redisConfigured: () => false, redisPipeline: async () => [null] }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

import { buildDemoProfiles } from "@/lib/bi-demo-seed";
import { hashShopperId } from "@/lib/bi-hash";
import { biProfileFromMeta, buildBiProfileFacts } from "@/lib/bi-profiles";
import { revokeUnlisted, setBiConsent } from "@/lib/marketing-sync";
import { MARKETING_CONSENT_VERSION } from "@/lib/marketing-text";
import { emitBiProfile } from "@/lib/store-meta";

const SUB = "auth0|rcxregionconsent";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const location = { postcode: "238823", consentAt: "2026-11-10T08:00:00.000Z", purpose: "area-personalisation" };
const marketing = { version: MARKETING_CONSENT_VERSION, consentAt: "2026-11-11T08:00:00.000Z" };

const statementOf = (call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join("?") : String(call[0]));
const inserts = () => sqlMock.mock.calls.filter((call) => statementOf(call).includes("INSERT INTO bi_customer_profiles"));
const REGION_INDEX = 7 - 1;
const regionWritten = () => inserts().at(-1)!.slice(1)[REGION_INDEX];

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  delete process.env.DEMO_SHOPPER_SUB;
  db.meta = {};
  sqlMock.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("RCX PDPA: location consent is not reused for BI region", () => {
  it("leaves the region out for a shopper who gave location consent but no marketing consent", async () => {
    db.meta = { location };
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    expect(regionWritten()).toBeNull();
    expect(JSON.stringify(sqlMock.mock.calls)).not.toContain("238823");
  });

  it("publishes the 2-digit region once the shopper has explicit marketing consent", async () => {
    db.meta = { location, marketing_consent: marketing };
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    expect(regionWritten()).toBe("23");
    expect(JSON.stringify(sqlMock.mock.calls)).not.toContain("238823");
  });

  it("drops the region again when marketing consent is withdrawn", async () => {
    db.meta = { location, marketing_consent: marketing };
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    delete db.meta.marketing_consent;
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(inserts()).toHaveLength(2));
    expect(regionWritten()).toBeNull();
  });

  it("biProfileFromMeta and buildBiProfileFacts only carry a region with consent", () => {
    const meta = { location };
    expect(biProfileFromMeta(meta, [], { isTest: false, now: NOW }).region).toBeNull();
    expect(biProfileFromMeta(meta, [], { isTest: false, now: NOW, marketing: { consent: true, at: marketing.consentAt } }).region).toBe("23");
    const base = { orders: [], profile: null, region: "23", isTest: false, now: NOW };
    expect(buildBiProfileFacts({ ...base, marketing: { consent: false, at: null } }).region).toBeNull();
    expect(buildBiProfileFacts({ ...base, marketing: { consent: true, at: marketing.consentAt } }).region).toBe("23");
  });

  it("gives demo rows a region only where they are marketing-consented", () => {
    for (const row of buildDemoProfiles(NOW)) {
      if (row.facts.marketingConsent) expect(row.facts.region).toMatch(/^\d{2}$/);
      else expect(row.facts.region).toBeNull();
    }
  });

  it("clears the stored region when a withdrawal is mirrored or reconciled in BI", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const sql = { query } as never;
    await setBiConsent(sql, hashShopperId(SUB), { consent: false, at: null });
    await revokeUnlisted(sql, []);
    for (const [text] of query.mock.calls as [string][]) {
      expect(text).toMatch(/region\s*=\s*(NULL|CASE)/i);
    }
    expect(query).toHaveBeenCalledTimes(2);
  });
});
