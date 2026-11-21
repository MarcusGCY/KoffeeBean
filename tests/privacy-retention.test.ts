import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Meta = Record<string, unknown>;
type Row = { marketing_consent: boolean; consent_at: string | null; updated_at: string };

const world = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  users: new Map<string, Meta>(),
  patched: [] as { sub: string; patch: Meta }[],
  failPatchFor: new Set<string>(),
  listComplete: true,
  biFailing: false,
  statements: [] as string[],
}));

vi.mock("@/lib/bi-db", () => {
  const query = async (text: string, params: unknown[]) => {
    if (world.biFailing) throw new Error("neon down");
    world.statements.push(text);
    if (text.startsWith("DELETE FROM bi_customer_profiles")) {
      const cutoff = Date.parse(params[0] as string);
      const gone: { shopper_hash: string }[] = [];
      for (const [hash, row] of world.rows) {
        if (Date.parse(row.updated_at) < cutoff) {
          world.rows.delete(hash);
          gone.push({ shopper_hash: hash });
        }
      }
      return gone;
    }
    if (text.includes("SELECT COUNT(*)")) {
      const cutoff = Date.parse(params[0] as string);
      return [{ n: [...world.rows.values()].filter((row) => Date.parse(row.updated_at) < cutoff).length }];
    }
    if (text.includes("marketing_consent <> $2")) {
      const [hash, consent, at] = params as [string, boolean, string | null];
      const row = world.rows.get(hash);
      if (!row || (row.marketing_consent === consent && row.consent_at === at)) return [];
      row.marketing_consent = consent;
      row.consent_at = at;
      return [{ shopper_hash: hash }];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const sql = Object.assign(async () => [], { query });
  return { biDbConfigured: () => true, getBiSql: () => sql };
});
vi.mock("@/lib/upstash", () => ({ redisConfigured: () => false, redisPipeline: async () => [null] }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async (sub: string) => structuredClone(world.users.get(sub) ?? {}),
  patchAppMetadata: async (sub: string, patch: Meta) => {
    if (world.failPatchFor.has(sub)) throw new Error("auth0 down");
    world.patched.push({ sub, patch: structuredClone(patch) });
    const next = { ...(world.users.get(sub) ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    world.users.set(sub, next);
    return structuredClone(next);
  },
  listUsersAppMetadata: async () => ({
    users: [...world.users].map(([userId, appMetadata]) => ({ userId, appMetadata: structuredClone(appMetadata) })),
    complete: world.listComplete,
  }),
}));

import * as purgeRoute from "@/app/api/privacy/purge/route";
import { getBiSql } from "@/lib/bi-db";
import { hashShopperId } from "@/lib/bi-hash";
import {
  keysToPurge,
  lastActivity,
  purgeProfiles,
  RETENTION_MONTHS_DEFAULT,
  retentionCutoff,
  retentionMonths,
} from "@/lib/retention";

const SECRET = "test-privacy-secret-0123456789";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const OLD = 800;
const FRESH = 30;
const sql = () => getBiSql()!;
const hashOf = (sub: string) => hashShopperId(sub);
const order = (days: number) => ({ id: "BB-ABC234", createdAt: ago(days), totalCents: 1000 });
const profileData = (days: number): Meta => ({
  barista_profile: { v: 1, updatedAt: ago(days), topProducts: [], cadenceDays: null, gramsPerDay: 20, preferredRoast: null },
  location: { postcode: "238823", consentAt: ago(days), purpose: "area-personalisation" },
  marketing_consent: { version: "2026-11-v1", consentAt: ago(days) },
});
const biRow = (sub: string, updatedDays: number, consent = false) =>
  world.rows.set(hashOf(sub), { marketing_consent: consent, consent_at: consent ? ago(updatedDays) : null, updated_at: ago(updatedDays) });

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  process.env.PRIVACY_MAINTENANCE_SECRET = SECRET;
  process.env.DATABASE_URL = "postgres://user:pw@retention.example/neondb";
  delete process.env.PRIVACY_RETENTION_MONTHS;
  world.rows.clear();
  world.users.clear();
  world.patched = [];
  world.failPatchFor.clear();
  world.listComplete = true;
  world.biFailing = false;
  world.statements = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("retention period", () => {
  it("defaults to 24 months", () => {
    expect(RETENTION_MONTHS_DEFAULT).toBe(24);
    expect(retentionMonths(undefined)).toBe(24);
    expect(retentionMonths("")).toBe(24);
  });

  it("reads PRIVACY_RETENTION_MONTHS and falls back to the default on anything unusable", () => {
    expect(retentionMonths("12")).toBe(12);
    expect(retentionMonths(" 36 ")).toBe(36);
    for (const bad of ["0", "-1", "121", "24.5", "abc", "1e2", "12 months"]) expect(retentionMonths(bad)).toBe(24);
    process.env.PRIVACY_RETENTION_MONTHS = "6";
    expect(retentionMonths()).toBe(6);
  });

  it("subtracts calendar months", () => {
    expect(retentionCutoff(NOW, 24).toISOString()).toBe("2024-11-21T08:00:00.000Z");
    expect(retentionCutoff(NOW, 12).toISOString()).toBe("2025-11-21T08:00:00.000Z");
  });
});

describe("keysToPurge", () => {
  const cutoff = retentionCutoff(NOW, 24);

  it("purges profile data of a shopper with no activity since the cutoff, and never orders", () => {
    const meta = { ...profileData(OLD), orders: [order(OLD)], audit: [{ ts: ago(OLD) }] };
    expect(keysToPurge(meta, cutoff).sort()).toEqual(["barista_profile", "location", "marketing_consent"]);
  });

  it("keeps everything for a shopper with a recent order, or a recent change to any profile item", () => {
    expect(keysToPurge({ ...profileData(OLD), orders: [order(OLD), order(FRESH)] }, cutoff)).toEqual([]);
    expect(keysToPurge({ ...profileData(OLD), location: { postcode: "238823", consentAt: ago(FRESH) } }, cutoff)).toEqual([]);
    expect(keysToPurge({ ...profileData(OLD), marketing_consent: { version: "v", consentAt: ago(FRESH) } }, cutoff)).toEqual([]);
  });

  it("does nothing when there is nothing to purge", () => {
    expect(keysToPurge({ orders: [order(OLD)] }, cutoff)).toEqual([]);
    expect(keysToPurge({}, cutoff)).toEqual([]);
  });

  it("treats activity exactly at the cutoff as still in the period", () => {
    const meta = { location: { postcode: "238823", consentAt: cutoff.toISOString() } };
    expect(lastActivity(meta)).toBe(cutoff.getTime());
    expect(keysToPurge(meta, cutoff)).toEqual([]);
    expect(keysToPurge({ location: { postcode: "238823", consentAt: new Date(cutoff.getTime() - 1).toISOString() } }, cutoff)).toEqual(["location"]);
  });

  it("treats data whose age cannot be read as old", () => {
    expect(keysToPurge({ barista_profile: { v: 1 }, location: "garbage" }, cutoff).sort()).toEqual(["barista_profile", "location"]);
  });
});

describe("purgeProfiles", () => {
  it("deletes BI rows older than the period and keeps newer ones", async () => {
    biRow("auth0|old", OLD);
    biRow("auth0|fresh", FRESH);
    const summary = await purgeProfiles(sql(), { now: NOW });
    expect(summary).toMatchObject({ dryRun: false, retentionMonths: 24, cutoff: "2024-11-21T08:00:00.000Z", bi: { rows: 1 } });
    expect(world.rows.has(hashOf("auth0|old"))).toBe(false);
    expect(world.rows.has(hashOf("auth0|fresh"))).toBe(true);
  });

  it("uses the configured period", async () => {
    biRow("auth0|a", 200);
    biRow("auth0|b", 100);
    process.env.PRIVACY_RETENTION_MONTHS = "5";
    const summary = await purgeProfiles(sql(), { now: NOW });
    expect(summary.retentionMonths).toBe(5);
    expect(summary.bi.rows).toBe(1);
    expect(world.rows.has(hashOf("auth0|b"))).toBe(true);
  });

  it("removes profile data from inactive Auth0 users only, keeping their orders", async () => {
    world.users.set("auth0|inactive", { ...profileData(OLD), orders: [order(OLD)] });
    world.users.set("auth0|active", { ...profileData(OLD), orders: [order(FRESH)] });
    world.users.set("auth0|empty", { orders: [order(OLD)] });
    const summary = await purgeProfiles(sql(), { now: NOW });
    expect(summary.auth0).toEqual({ scanned: 3, complete: true, users: 1, failed: 0 });
    expect(world.users.get("auth0|inactive")).toEqual({ orders: [order(OLD)] });
    expect(world.users.get("auth0|active")?.barista_profile).toBeDefined();
    expect(world.patched.map((item) => item.sub)).toEqual(["auth0|inactive"]);
    expect(world.patched[0]!.patch).toEqual({ barista_profile: null, location: null, marketing_consent: null });
  });

  it("also withdraws BI consent for a shopper whose marketing consent it removed", async () => {
    world.users.set("auth0|inactive", profileData(OLD));
    biRow("auth0|inactive", 10, true);
    await purgeProfiles(sql(), { now: NOW });
    expect(world.rows.get(hashOf("auth0|inactive"))).toMatchObject({ marketing_consent: false, consent_at: null });
  });

  it("with dryRun counts and changes nothing", async () => {
    biRow("auth0|old", OLD);
    world.users.set("auth0|inactive", profileData(OLD));
    const summary = await purgeProfiles(sql(), { now: NOW, dryRun: true });
    expect(summary).toMatchObject({ dryRun: true, bi: { rows: 1 }, auth0: { users: 1, failed: 0 } });
    expect(world.rows.size).toBe(1);
    expect(world.patched).toEqual([]);
    expect(world.users.get("auth0|inactive")?.location).toBeDefined();
    expect(world.statements.some((text) => text.startsWith("DELETE"))).toBe(false);
  });

  it("is idempotent: a second run finds nothing", async () => {
    biRow("auth0|old", OLD);
    world.users.set("auth0|inactive", profileData(OLD));
    await purgeProfiles(sql(), { now: NOW });
    const second = await purgeProfiles(sql(), { now: NOW });
    expect(second.bi.rows).toBe(0);
    expect(second.auth0.users).toBe(0);
  });

  it("counts a failed Auth0 user and carries on with the rest, and reports an incomplete scan", async () => {
    world.listComplete = false;
    world.users.set("auth0|bad", profileData(OLD));
    world.users.set("auth0|good", profileData(OLD));
    world.failPatchFor.add("auth0|bad");
    const summary = await purgeProfiles(sql(), { now: NOW });
    expect(summary.auth0).toEqual({ scanned: 2, complete: false, users: 2, failed: 1 });
    expect(world.users.get("auth0|good")?.location).toBeUndefined();
    expect(world.users.get("auth0|bad")?.location).toBeDefined();
  });

  it("never touches an existing BI row other than by its age", async () => {
    biRow("auth0|fresh", FRESH, true);
    await purgeProfiles(sql(), { now: NOW });
    expect(world.rows.get(hashOf("auth0|fresh"))?.marketing_consent).toBe(true);
  });
});

describe("POST /api/privacy/purge", () => {
  const post = (body?: string, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
    purgeRoute.POST(new Request("http://localhost/api/privacy/purge", { method: "POST", headers, body }));

  it("exports POST only", () => {
    expect(Object.keys(purgeRoute).sort()).toEqual(["POST"]);
  });

  it("is 401 without the secret and 503 when it is unset, never open", async () => {
    expect((await post(undefined, {})).status).toBe(401);
    expect((await post(undefined, { authorization: "Bearer nope" })).status).toBe(401);
    delete process.env.PRIVACY_MAINTENANCE_SECRET;
    expect((await post()).status).toBe(503);
    expect(world.statements).toEqual([]);
  });

  it("rejects an unknown or malformed body", async () => {
    for (const body of ["{", '{"dryRun":"yes"}', '{"months":1}', "[]"]) expect((await post(body)).status).toBe(400);
    expect(world.statements).toEqual([]);
  });

  it("runs with an empty body and returns counts only", async () => {
    biRow("auth0|old", OLD);
    world.users.set("auth0|inactive", profileData(OLD));
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ dryRun: false, retentionMonths: 24, bi: { rows: 1 }, auth0: { users: 1 } });
    expect(text).not.toContain("auth0|");
    expect(text).not.toContain(hashOf("auth0|old"));
  });

  it("honours dryRun", async () => {
    biRow("auth0|old", OLD);
    const res = await post('{"dryRun":true}');
    expect(await res.json()).toMatchObject({ dryRun: true, bi: { rows: 1 } });
    expect(world.rows.size).toBe(1);
  });

  it("is 503 with no detail when a database fails", async () => {
    world.biFailing = true;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("no production schedule", () => {
  it("adds no cron for the privacy routes", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string }[] };
    expect((config.crons ?? []).filter((cron) => cron.path.includes("privacy"))).toEqual([]);
  });

  it("is documented as pending the privacy owner", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toMatch(/pending the privacy owner/i);
    expect(readme).toMatch(/PRIVACY_RETENTION_MONTHS/);
    expect(readme).toMatch(/PRIVACY_MAINTENANCE_SECRET/);
  });
});
