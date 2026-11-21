import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
const biState = vi.hoisted(() => ({ configured: true }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => void task(),
}));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => biState.configured, getBiSql: () => (biState.configured ? sqlMock : null) }));
vi.mock("@/lib/upstash", () => ({ redisConfigured: () => false, redisPipeline: async () => [null] }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    const next = { ...db.meta };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    db.meta = next;
    return structuredClone(db.meta);
  },
}));
vi.mock("@/lib/shopper", () => ({ getShopper: vi.fn(), reporterBlock: () => "" }));

import { PATCH } from "@/app/api/account/profile/route";
import { PUT as putMarketing } from "@/app/api/account/marketing/route";
import { emptyProfile } from "@/lib/barista-profile";
import { hashShopperId } from "@/lib/bi-hash";
import { MARKETING_CONSENT_VERSION } from "@/lib/marketing-text";
import { getShopper } from "@/lib/shopper";
import { cancelOrder, emitBiProfile, mirrorProfileToBi, placeOrder } from "@/lib/store-meta";

const SUB = "auth0|rcxpersonalizationoff";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const cart = { items: [{ productId: "ethiopia-250", qty: 2 }], coupon: null };
const offProfile = () => ({ ...emptyProfile(NOW), off: true });
const consent = { version: MARKETING_CONSENT_VERSION, consentAt: "2026-11-01T08:00:00.000Z" };

const statementOf = (call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join("?") : String(call[0]));
const inserts = () => sqlMock.mock.calls.filter((call) => statementOf(call).includes("INSERT INTO bi_customer_profiles"));
const deletes = () => sqlMock.mock.calls.filter((call) => /DELETE\s+FROM\s+bi_customer_profiles/i.test(statementOf(call)));

function patchProfile(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/account/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  process.env.APP_BASE_URL = "http://localhost:3000";
  delete process.env.DEMO_SHOPPER_SUB;
  db.meta = {};
  biState.configured = true;
  sqlMock.mockReset().mockResolvedValue([]);
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "ada@example.com", name: "Ada" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("RCX PDPA: personalization off means no BI profile row", () => {
  it("writes no row when an order is placed, and removes any existing row", async () => {
    db.meta = { cart, barista_profile: offProfile() };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(inserts()).toHaveLength(0);
    expect(deletes()[0]!.slice(1)).toEqual([hashShopperId(SUB)]);
  });

  it("writes no row and removes the existing row when an order is cancelled", async () => {
    db.meta = { cart };
    const placed = (await placeOrder(SUB, NOW)) as { id: string };
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    db.meta = { ...db.meta, barista_profile: offProfile() };
    sqlMock.mockClear();
    await cancelOrder(SUB, placed.id, new Date(NOW.getTime() + 60_000));
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(inserts()).toHaveLength(0);
  });

  it("deletes the row on a profile refresh instead of upserting it", async () => {
    db.meta = { barista_profile: offProfile(), marketing_consent: consent };
    emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(inserts()).toHaveLength(0);
  });

  it("deletes the existing row when the shopper turns personalization off", async () => {
    db.meta = { cart };
    await placeOrder(SUB, NOW);
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    sqlMock.mockClear();

    const res = await patchProfile({ personalization: "off" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]!.slice(1)).toEqual([hashShopperId(SUB)]);
    expect(inserts()).toHaveLength(0);
  });

  it("writes the row again once personalization is turned back on", async () => {
    db.meta = { barista_profile: offProfile() };
    const res = await patchProfile({ personalization: "on" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(inserts()).toHaveLength(1));
    expect(deletes()).toHaveLength(0);
  });

  it("does not recreate a row when the shopper opts in to marketing with personalization off", async () => {
    db.meta = { barista_profile: offProfile() };
    const res = await putMarketing(
      new Request("http://localhost/api/account/marketing", {
        method: "PUT",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ consent: true, version: MARKETING_CONSENT_VERSION }),
      }),
    );
    expect(res.status).toBe(200);
    expect(inserts()).toHaveLength(0);
  });

  it("mirrorProfileToBi deletes rather than upserts, and says whether BI is in step", async () => {
    db.meta = { barista_profile: offProfile() };
    await expect(mirrorProfileToBi(SUB, NOW)).resolves.toBe(true);
    expect(inserts()).toHaveLength(0);
    expect(deletes()).toHaveLength(1);
  });

  it("fails safe when BI is unavailable: never throws, reports unsynced, logs no PII or SQL", async () => {
    sqlMock.mockRejectedValue(new Error(`relation "bi_customer_profiles" does not exist for ${SUB}`));
    db.meta = { cart, barista_profile: offProfile() };
    await expect(placeOrder(SUB, NOW)).resolves.toMatchObject({ id: expect.any(String) });
    await vi.waitFor(() => expect(deletes().length).toBeGreaterThan(0));
    await expect(mirrorProfileToBi(SUB, NOW)).resolves.toBe(false);
    emitBiProfile(SUB, NOW);
    const res = await patchProfile({ personalization: "off" });
    expect(res.status).toBe(200);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(SUB);
    expect(logged).not.toMatch(/DELETE|INSERT|bi_customer_profiles/);
  });

  it("does nothing at all when BI is not configured", async () => {
    biState.configured = false;
    db.meta = { barista_profile: offProfile() };
    await expect(mirrorProfileToBi(SUB, NOW)).resolves.toBe(true);
    emitBiProfile(SUB, NOW);
    await patchProfile({ personalization: "off" });
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
