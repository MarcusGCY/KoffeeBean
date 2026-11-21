import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, patches: [] as Record<string, unknown>[] }));
const biState = vi.hoisted(() => ({ configured: true }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => void task(),
}));
vi.mock("@/lib/bi-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bi-events")>()),
  recordBiEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/bi-db", () => ({ biDbConfigured: () => biState.configured, getBiSql: () => (biState.configured ? sqlMock : null) }));
vi.mock("@/lib/upstash", () => ({ redisPipeline: async () => [null] }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.patches.push(structuredClone(patch));
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

import { DELETE, GET, PUT } from "@/app/api/account/marketing/route";
import { biProfileFromMeta } from "@/lib/bi-profiles";
import { MARKETING_CONSENT_VERSION, marketingOf, marketingView, normalizeMarketing } from "@/lib/marketing-text";
import { getShopper } from "@/lib/shopper";
import { emitBiProfile } from "@/lib/store-meta";

const SUB = "auth0|shopper";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function profileCalls() {
  return sqlMock.mock.calls.filter(([strings]) => Array.isArray(strings) && strings.join("").includes("bi_customer_profiles"));
}
const lastValues = () => profileCalls().at(-1)!.slice(1);

function call(method: "PUT" | "DELETE", body?: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) {
  const req = new Request("http://localhost/api/account/marketing", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return method === "PUT" ? PUT(req) : DELETE(req);
}

const optIn = { consent: true, version: MARKETING_CONSENT_VERSION };
const toolsAudited = () => ((db.meta.audit as { tool: string }[] | undefined) ?? []).map((entry) => entry.tool);

beforeEach(() => {
  process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
  process.env.APP_BASE_URL = "http://localhost:3000";
  delete process.env.DEMO_SHOPPER_SUB;
  db.meta = {};
  db.patches = [];
  biState.configured = true;
  sqlMock.mockReset().mockResolvedValue([]);
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "ada@example.com", name: "Ada" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("marketing consent state", () => {
  it("is off for a shopper who never opted in", () => {
    expect(marketingView({})).toEqual({ consented: false, consentAt: null, needsRenewal: false, version: MARKETING_CONSENT_VERSION });
    expect(marketingOf({})).toEqual({ consent: false, at: null });
  });

  it("counts only the current wording, and asks for renewal on older wording", () => {
    const current = { version: MARKETING_CONSENT_VERSION, consentAt: ago(3) };
    expect(marketingOf({ marketing_consent: current })).toEqual({ consent: true, at: current.consentAt });
    const old = { version: "2025-01-v0", consentAt: ago(300) };
    expect(marketingOf({ marketing_consent: old })).toEqual({ consent: false, at: null });
    expect(marketingView({ marketing_consent: old })).toMatchObject({ consented: false, needsRenewal: true });
  });

  it("treats a malformed or half-written value as no consent", () => {
    for (const value of [true, "yes", [], {}, { version: MARKETING_CONSENT_VERSION }, { consentAt: ago(1) }, { version: "bad version!", consentAt: ago(1) }, { version: MARKETING_CONSENT_VERSION, consentAt: "not a date" }]) {
      expect(normalizeMarketing(value)).toBeNull();
      expect(marketingOf({ marketing_consent: value }).consent).toBe(false);
    }
  });

  it("is mirrored by biProfileFromMeta, and defaults to off when no marketing option is given", () => {
    const meta = { marketing_consent: { version: MARKETING_CONSENT_VERSION, consentAt: ago(3) } };
    expect(biProfileFromMeta(meta, [], { isTest: false, now: NOW, marketing: marketingOf(meta) })).toMatchObject({
      marketingConsent: true,
      consentAt: ago(3),
    });
    expect(biProfileFromMeta(meta, [], { isTest: false, now: NOW })).toMatchObject({ marketingConsent: false, consentAt: null });
  });
});

describe("PUT /api/account/marketing: opt in", () => {
  it("stores the version and time, audits it, and mirrors true to BI", async () => {
    const res = await call("PUT", optIn);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { marketing: { consented: boolean; consentAt: string; version: string }; biSynced: boolean };
    expect(body.marketing).toMatchObject({ consented: true, version: MARKETING_CONSENT_VERSION });
    expect(body.biSynced).toBe(true);
    expect(db.meta.marketing_consent).toEqual({ version: MARKETING_CONSENT_VERSION, consentAt: body.marketing.consentAt });
    expect(toolsAudited()).toEqual(["marketing.consent"]);
    expect(lastValues().slice(7, 10)).toEqual([false, true, body.marketing.consentAt]);
  });

  it("is never implied: needs the literal consent true, and no other fields", async () => {
    for (const payload of [{}, { version: MARKETING_CONSENT_VERSION }, { consent: false, version: MARKETING_CONSENT_VERSION }, { consent: "true", version: MARKETING_CONSENT_VERSION }, { ...optIn, extra: 1 }]) {
      expect((await call("PUT", payload)).status).toBe(400);
    }
    expect(db.meta.marketing_consent).toBeUndefined();
    expect(profileCalls()).toHaveLength(0);
  });

  it("refuses consent against wording the shopper did not see", async () => {
    const res = await call("PUT", { consent: true, version: "2025-01-v0" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stale_version", version: MARKETING_CONSENT_VERSION });
    expect(db.meta.marketing_consent).toBeUndefined();
  });

  it("is separate from location and personalization: it writes only its own key", async () => {
    db.meta = { location: { postcode: "238823", consentAt: ago(5), purpose: "area-personalisation" } };
    await call("PUT", optIn);
    expect(db.patches.some((patch) => Object.keys(patch).includes("marketing_consent"))).toBe(true);
    expect(db.patches.filter((patch) => "marketing_consent" in patch).every((patch) => !("location" in patch) && !("barista_profile" in patch))).toBe(true);
    expect(db.meta.location).toBeDefined();
  });

  it("needs a same-origin write and a signed-in shopper", async () => {
    expect((await call("PUT", optIn, { origin: "https://evil.example" })).status).toBe(403);
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await call("PUT", optIn)).status).toBe(401);
    expect(db.meta.marketing_consent).toBeUndefined();
  });

  it("still saves the consent, and says so, when the BI write fails", async () => {
    sqlMock.mockRejectedValue(new Error("neon down"));
    const res = await call("PUT", optIn);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { biSynced: boolean }).biSynced).toBe(false);
    expect(db.meta.marketing_consent).toBeDefined();
  });

  it("does not claim a BI write when BI is not configured", async () => {
    biState.configured = false;
    const res = await call("PUT", optIn);
    expect(((await res.json()) as { biSynced: boolean }).biSynced).toBe(true);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/account/marketing: withdraw", () => {
  const consent = { version: MARKETING_CONSENT_VERSION, consentAt: ago(10) };

  it("removes the key, audits it, and mirrors false with no consent time to BI", async () => {
    db.meta = { marketing_consent: consent };
    await emitBiProfile(SUB, NOW);
    await vi.waitFor(() => expect(profileCalls()).toHaveLength(1));
    expect(lastValues().slice(8, 10)).toEqual([true, consent.consentAt]);

    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ marketing: { consented: false, consentAt: null }, biSynced: true });
    expect(db.meta.marketing_consent).toBeUndefined();
    expect(toolsAudited()).toEqual(["marketing.withdraw"]);
    expect(profileCalls()).toHaveLength(2);
    expect(lastValues().slice(8, 10)).toEqual([false, null]);
  });

  it("writes BI before answering, and reports when it could not", async () => {
    db.meta = { marketing_consent: consent };
    sqlMock.mockRejectedValue(new Error("neon down"));
    const res = await call("DELETE");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { biSynced: boolean }).biSynced).toBe(false);
    expect(db.meta.marketing_consent).toBeUndefined();
  });

  it("is harmless for a shopper who never opted in", async () => {
    expect((await call("DELETE")).status).toBe(200);
    expect(db.meta.marketing_consent).toBeUndefined();
  });

  it("needs a same-origin write", async () => {
    db.meta = { marketing_consent: consent };
    expect((await call("DELETE", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect(db.meta.marketing_consent).toEqual(consent);
  });
});

describe("GET /api/account/marketing", () => {
  it("reports the current state without caching", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ marketing: { consented: false, consentAt: null, needsRenewal: false, version: MARKETING_CONSENT_VERSION } });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});

describe("what reaches BI", () => {
  it("carries no postcode, email or shopper id, only consent flag and time", async () => {
    db.meta = { location: { postcode: "238823", consentAt: ago(5), purpose: "area-personalisation" } };
    await call("PUT", optIn);
    const everything = JSON.stringify(sqlMock.mock.calls);
    expect(everything).not.toContain("238823");
    expect(everything).not.toContain("ada@example.com");
    expect(everything).not.toContain(SUB);
    expect(lastValues()[6]).toBe("23");
  });

  it("keeps the migration constraint that a consent time exists exactly when consent is true", () => {
    const sql = readFileSync("db/migrations/0003_bi_customer_profiles.sql", "utf8");
    expect(sql).toContain("CHECK (NOT marketing_consent OR consent_at IS NOT NULL)");
    expect(sql).toContain("CHECK (marketing_consent OR consent_at IS NULL)");
  });
});

describe("README retention note", () => {
  const readme = readFileSync("README.md", "utf8");

  it("is honest that no purge job runs in code", () => {
    expect(readme).toMatch(/Personalization data and retention/);
    expect(readme).toMatch(/no scheduled (job|purge)/i);
  });
});
