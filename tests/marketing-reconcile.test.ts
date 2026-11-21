import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { marketing_consent: boolean; consent_at: string | null; updated_at: string; source: string };
type Meta = Record<string, unknown>;

const world = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  biFailing: false,
  users: new Map<string, Meta>(),
  listComplete: true,
  listFails: false,
  redisOn: true,
  redisFailing: false,
  sets: new Map<string, Set<string>>(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => void task(),
}));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/bi-db", () => {
  const tag = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    if (world.biFailing) throw new Error("neon down");
    if (!strings.join("?").includes("INSERT INTO bi_customer_profiles")) throw new Error("unexpected statement");
    world.rows.set(v[0] as string, { marketing_consent: v[8] as boolean, consent_at: v[9] as string | null, updated_at: v[11] as string, source: v[10] as string });
    return [];
  };
  const query = async (text: string, params: unknown[]) => {
    if (world.biFailing) throw new Error("neon down");
    if (text.includes("marketing_consent <> $2")) {
      const [hash, consent, at] = params as [string, boolean, string | null];
      const row = world.rows.get(hash);
      if (!row || (row.marketing_consent === consent && row.consent_at === at)) return [];
      row.marketing_consent = consent;
      row.consent_at = at;
      return [{ shopper_hash: hash }];
    }
    if (text.includes("ANY($1::text[])")) {
      const keep = new Set(params[0] as string[]);
      const changed: { shopper_hash: string }[] = [];
      for (const [hash, row] of world.rows) {
        if (row.marketing_consent && !keep.has(hash)) {
          row.marketing_consent = false;
          row.consent_at = null;
          changed.push({ shopper_hash: hash });
        }
      }
      return changed;
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const sql = Object.assign(tag, { query });
  return { biDbConfigured: () => true, getBiSql: () => sql };
});
vi.mock("@/lib/upstash", () => ({
  redisConfigured: () => world.redisOn,
  redisPipeline: async (commands: string[][]) => {
    if (world.redisFailing) throw new Error("redis down");
    return commands.map(([cmd, key, member]) => {
      const set = world.sets.get(key!) ?? new Set<string>();
      world.sets.set(key!, set);
      if (cmd === "SADD") return set.add(member!) && 1;
      if (cmd === "SREM") return set.delete(member!) ? 1 : 0;
      if (cmd === "SMEMBERS") return [...set];
      return null;
    });
  },
}));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async (sub: string) => structuredClone(world.users.get(sub) ?? {}),
  patchAppMetadata: async (sub: string, patch: Meta) => {
    const next = { ...(world.users.get(sub) ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    world.users.set(sub, next);
    return structuredClone(next);
  },
  listUsersAppMetadata: async () => {
    if (world.listFails) throw new Error("auth0 down");
    return { users: [...world.users].map(([userId, appMetadata]) => ({ userId, appMetadata: structuredClone(appMetadata) })), complete: world.listComplete };
  },
}));
vi.mock("@/lib/shopper", () => ({ getShopper: vi.fn(), reporterBlock: () => "" }));

import * as reconcileRoute from "@/app/api/privacy/reconcile-marketing/route";
import { DELETE, PUT } from "@/app/api/account/marketing/route";
import { hashShopperId } from "@/lib/bi-hash";
import { biProfiles } from "@/lib/bi-profiles-read";
import { clearWithdrawalPending, markWithdrawalPending, reconcileMarketing, withdrawnHashes } from "@/lib/marketing-sync";
import { MARKETING_CONSENT_VERSION } from "@/lib/marketing-text";
import { getShopper } from "@/lib/shopper";
import { getBiSql } from "@/lib/bi-db";

const SECRET = "test-privacy-secret-0123456789";
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const consentMeta = (days = 5): Meta => ({ marketing_consent: { version: MARKETING_CONSENT_VERSION, consentAt: ago(days) } });
const sql = () => getBiSql()!;
const hashOf = (sub: string) => hashShopperId(sub);
const biRow = (sub: string, consent: boolean, at: string | null = consent ? ago(5) : null) =>
  world.rows.set(hashOf(sub), { marketing_consent: consent, consent_at: at, updated_at: ago(1), source: "live" });
const setOf = (key: string) => [...(world.sets.get(key) ?? [])];
const RETRY = "kb:bi:consent:retry";
const WITHDRAWN = "kb:bi:consent:withdrawn";

function account(method: "PUT" | "DELETE", body?: unknown) {
  const req = new Request("http://localhost/api/account/marketing", {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return method === "PUT" ? PUT(req) : DELETE(req);
}

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.PRIVACY_MAINTENANCE_SECRET = SECRET;
  delete process.env.DEMO_SHOPPER_SUB;
  world.rows.clear();
  world.users.clear();
  world.sets.clear();
  world.biFailing = false;
  world.listComplete = true;
  world.listFails = false;
  world.redisOn = true;
  world.redisFailing = false;
  vi.mocked(getShopper).mockResolvedValue({ id: "auth0|ada", email: "ada@example.com", name: "Ada" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("withdrawal when the BI write fails", () => {
  it("records the withdrawal first, answers with retryQueued, and keeps Auth0 as the truth", async () => {
    world.users.set("auth0|ada", {});
    expect((await account("PUT", { consent: true, version: MARKETING_CONSENT_VERSION })).status).toBe(200);
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(true);

    world.biFailing = true;
    const res = await account("DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marketing: { consented: false }, biSynced: false, retryQueued: true });
    expect(world.users.get("auth0|ada")?.marketing_consent).toBeUndefined();
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(true);
    expect(setOf(RETRY)).toEqual(["auth0|ada"]);
    expect(setOf(WITHDRAWN)).toEqual([hashOf("auth0|ada")]);
  });

  it("clears the record when the BI write lands", async () => {
    world.users.set("auth0|ada", consentMeta());
    biRow("auth0|ada", true);
    const res = await account("DELETE");
    expect(await res.json()).toMatchObject({ biSynced: true, retryQueued: false });
    expect(world.rows.get(hashOf("auth0|ada"))).toMatchObject({ marketing_consent: false, consent_at: null });
    expect(setOf(RETRY)).toEqual([]);
    expect(setOf(WITHDRAWN)).toEqual([]);
  });

  it("says retryQueued false when Redis is down too, and reconcile by scan still fixes it", async () => {
    world.users.set("auth0|ada", consentMeta());
    biRow("auth0|ada", true);
    world.biFailing = true;
    world.redisFailing = true;
    const res = await account("DELETE");
    expect(await res.json()).toMatchObject({ biSynced: false, retryQueued: false });

    world.biFailing = false;
    world.redisFailing = false;
    world.users.set("auth0|ada", {});
    const summary = await reconcileMarketing(sql());
    expect(summary.revoked).toBe(1);
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(false);
  });

  it("clears a pending withdrawal when the shopper agrees again", async () => {
    world.users.set("auth0|ada", {});
    await markWithdrawalPending("auth0|ada");
    expect(setOf(RETRY)).toHaveLength(1);
    await account("PUT", { consent: true, version: MARKETING_CONSENT_VERSION });
    expect(setOf(RETRY)).toEqual([]);
    expect(setOf(WITHDRAWN)).toEqual([]);
  });
});

describe("reconcileMarketing", () => {
  it("fixes a failed withdrawal from the retry queue, then changes nothing on later runs", async () => {
    world.users.set("auth0|ada", consentMeta());
    biRow("auth0|ada", true);
    world.biFailing = true;
    await account("DELETE");
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(true);
    world.biFailing = false;

    const first = await reconcileMarketing(sql());
    expect(first.queue).toEqual({ checked: 1, corrected: 1, failed: 0 });
    expect(world.rows.get(hashOf("auth0|ada"))).toMatchObject({ marketing_consent: false, consent_at: null });
    expect(setOf(RETRY)).toEqual([]);
    expect(setOf(WITHDRAWN)).toEqual([]);

    const snapshot = JSON.stringify([...world.rows]);
    for (let run = 0; run < 3; run += 1) {
      const again = await reconcileMarketing(sql());
      expect(again).toEqual({ queue: { checked: 0, corrected: 0, failed: 0 }, scan: { users: 1, complete: true }, revoked: 0 });
    }
    expect(JSON.stringify([...world.rows])).toBe(snapshot);
  });

  it("keeps a failed item queued and reports it", async () => {
    world.users.set("auth0|ada", {});
    biRow("auth0|ada", true);
    await markWithdrawalPending("auth0|ada");
    world.biFailing = true;
    await expect(reconcileMarketing(sql())).rejects.toThrow();
    expect(setOf(RETRY)).toEqual(["auth0|ada"]);
    expect(setOf(WITHDRAWN)).toEqual([hashOf("auth0|ada")]);
    world.biFailing = false;
    expect((await reconcileMarketing(sql())).queue.corrected).toBe(1);
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(false);
  });

  it("withdraws a missed withdrawal found only by the scan, with no Redis at all", async () => {
    world.redisOn = false;
    world.users.set("auth0|ada", {});
    world.users.set("auth0|bob", consentMeta());
    biRow("auth0|ada", true);
    biRow("auth0|bob", true);
    const summary = await reconcileMarketing(sql());
    expect(summary).toEqual({ queue: { checked: 0, corrected: 0, failed: 0 }, scan: { users: 2, complete: true }, revoked: 1 });
    expect(world.rows.get(hashOf("auth0|ada"))?.marketing_consent).toBe(false);
    expect(world.rows.get(hashOf("auth0|bob"))).toMatchObject({ marketing_consent: true });
  });

  it("withdraws consent for a deleted account and for consent given under older wording", async () => {
    world.users.set("auth0|old", { marketing_consent: { version: "2025-01-v0", consentAt: ago(300) } });
    biRow("auth0|old", true);
    biRow("auth0|gone", true);
    const summary = await reconcileMarketing(sql());
    expect(summary.revoked).toBe(2);
    expect(world.rows.get(hashOf("auth0|old"))?.marketing_consent).toBe(false);
    expect(world.rows.get(hashOf("auth0|gone"))?.marketing_consent).toBe(false);
  });

  it("skips the sweep when the scan did not reach every user, so an unseen user keeps their consent", async () => {
    world.listComplete = false;
    biRow("auth0|unseen", true);
    const summary = await reconcileMarketing(sql());
    expect(summary).toMatchObject({ scan: { complete: false }, revoked: 0 });
    expect(world.rows.get(hashOf("auth0|unseen"))?.marketing_consent).toBe(true);
  });

  it("only ever turns consent off in a scan; a missing consent in BI is left for the shopper's next write", async () => {
    world.users.set("auth0|bob", consentMeta());
    biRow("auth0|bob", false);
    await reconcileMarketing(sql());
    expect(world.rows.get(hashOf("auth0|bob"))?.marketing_consent).toBe(false);
  });

  it("copies Auth0's answer for a queued shopper in either direction", async () => {
    world.users.set("auth0|bob", consentMeta(2));
    biRow("auth0|bob", false);
    await markWithdrawalPending("auth0|bob");
    await reconcileMarketing(sql());
    expect(world.rows.get(hashOf("auth0|bob"))?.marketing_consent).toBe(true);
  });

  it("never creates a BI row", async () => {
    world.users.set("auth0|bob", consentMeta());
    await reconcileMarketing(sql());
    expect(world.rows.size).toBe(0);
  });
});

describe("reads that gate per-shopper rows", () => {
  const rowFor = (sub: string) => ({
    shopper_hash: hashOf(sub),
    segment: "repeat",
    cadence_days: 14,
    aov_cents: 2400,
    orders_90d: 3,
    preferred_roast: "medium",
    region: "23",
    marketing_consent: true,
    consent_at: new Date(ago(5)),
    updated_at: new Date(ago(1)),
  });

  function fakeSql(rows: ReturnType<typeof rowFor>[]) {
    return {
      query: async (text: string) => {
        if (text.includes("percentile_cont")) return [{ shoppers: 9, consented: rows.length }];
        if (text.includes("marketing_consent = true")) return rows;
        if (text.includes("is_test = true")) return [{ n: 0 }];
        return [];
      },
    } as never;
  }
  const query = { source: "live", limit: 50 } as const;

  it("leaves out a shopper whose withdrawal is not in BI yet", async () => {
    world.users.set("auth0|ada", {});
    await markWithdrawalPending("auth0|ada");
    const lookup = await withdrawnHashes();
    const result = await biProfiles(fakeSql([rowFor("auth0|ada"), rowFor("auth0|bob")]), query, lookup);
    expect(result.rows.map((row) => row.shopper_hash)).toEqual([hashOf("auth0|bob")]);
    expect(result.consentCheck).toBe("auth0_withdrawals");
  });

  it("lists the shopper again once the withdrawal record is cleared and the row is current", async () => {
    await markWithdrawalPending("auth0|ada");
    await clearWithdrawalPending("auth0|ada");
    const result = await biProfiles(fakeSql([rowFor("auth0|ada")]), query, await withdrawnHashes());
    expect(result.rows).toHaveLength(1);
  });

  it("withholds every per-shopper row when the withdrawal record cannot be read", async () => {
    world.redisFailing = true;
    const lookup = await withdrawnHashes();
    expect(lookup).toEqual({ state: "unavailable" });
    const result = await biProfiles(fakeSql([rowFor("auth0|bob")]), query, lookup);
    expect(result.rows).toEqual([]);
    expect(result.consentCheck).toBe("unavailable");
    expect(result.nextCursor).toBeUndefined();
  });

  it("says bi_only when no withdrawal record is configured", async () => {
    world.redisOn = false;
    const lookup = await withdrawnHashes();
    expect(lookup).toEqual({ state: "bi_only" });
    expect((await biProfiles(fakeSql([rowFor("auth0|bob")]), query, lookup)).consentCheck).toBe("bi_only");
  });

  it("pages by the rows the database returned, not the ones filtered out", async () => {
    await markWithdrawalPending("auth0|a");
    const rows = [rowFor("auth0|a"), rowFor("auth0|b"), rowFor("auth0|c")];
    const result = await biProfiles(fakeSql(rows), { source: "live", limit: 2 }, await withdrawnHashes());
    expect(result.rows.map((row) => row.shopper_hash)).toEqual([hashOf("auth0|b")]);
    expect(result.nextCursor).toBe(hashOf("auth0|b"));
  });
});

describe("POST /api/privacy/reconcile-marketing", () => {
  const post = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) =>
    reconcileRoute.POST(new Request("http://localhost/api/privacy/reconcile-marketing", { method: "POST", headers }));

  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://user:pw@privacy.example/neondb";
  });

  it("exports POST only", () => {
    expect(Object.keys(reconcileRoute).sort()).toEqual(["POST"]);
  });

  it("is 401 without the secret or with the BI read secret, and 503 when unconfigured", async () => {
    process.env.BI_API_SECRET = "a-different-bi-secret-0123456789";
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${process.env.BI_API_SECRET}` }, { "x-bi-secret": SECRET }]) {
      expect((await post(headers)).status).toBe(401);
    }
    delete process.env.PRIVACY_MAINTENANCE_SECRET;
    expect((await post()).status).toBe(503);
    process.env.PRIVACY_MAINTENANCE_SECRET = "short";
    expect((await post()).status).toBe(503);
  });

  it("runs the reconcile and returns counts only", async () => {
    world.users.set("auth0|ada", {});
    biRow("auth0|ada", true);
    const res = await post();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ queue: { checked: 0, corrected: 0, failed: 0 }, scan: { users: 1, complete: true }, revoked: 1 });
    expect(text).not.toContain("auth0|");
    expect(text).not.toContain(hashOf("auth0|ada"));
    expect((await (await post()).json()) as unknown).toMatchObject({ revoked: 0 });
  });

  it("is 503 with no detail when Auth0 or BI fails", async () => {
    world.listFails = true;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    world.listFails = false;
    world.biFailing = true;
    expect((await post()).status).toBe(503);
  });
});
