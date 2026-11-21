import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as prefsGet, POST as prefsPost } from "@/app/api/agent/prefs/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { MAX_CAP_CENTS, MIN_CAP_CENTS, parseCustomCapDollars, validCap } from "@/lib/agent-cap";
import { proposeAction } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";
import { listOrders } from "@/lib/store-meta";
import { createTestPayment, readTestPayment } from "@/lib/test-payment";

const SUB = "auth0|shopper";
const nonces = vi.hoisted(() => ({ ids: new Set<string>() }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("@/lib/upstash", () => ({
  issueNonce: async (jti: string) => void nonces.ids.add(jti),
  consumeNonce: async (jti: string) => nonces.ids.delete(jti),
  rearmNonce: async (jti: string) => void nonces.ids.add(jti),
  rememberedLines: async () => [],
}));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));
vi.mock("@/lib/shopper", () => ({ getShopper: vi.fn(), reporterBlock: () => "" }));
vi.mock("@/lib/rate-limit", () => ({ tooManyFeedbackReports: async () => false }));
vi.mock("@/lib/file-feedback", () => ({ fileFeedback: async () => undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => void task(),
}));

/** Ethiopia 250g at 1800 plus 8% tax. */
const ETHIOPIA_TOTAL = 1944;

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

async function pendingOrder() {
  const pending = await proposeAction(SUB, { op: "place_order" });
  if (!("actionId" in pending)) throw new Error(`expected pending, got ${JSON.stringify(pending)}`);
  return pending.actionId;
}

async function confirmJson(actionId: string) {
  const res = await confirm(post("/api/chat/confirm", { actionId }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function setUp(prefs: Record<string, unknown> | undefined, cart = [{ productId: "ethiopia-250", qty: 1 }]) {
  db.meta = { cart: { items: cart, coupon: null }, ...(prefs ? { agent_prefs: prefs } : {}) };
}

beforeEach(() => {
  nonces.ids.clear();
  db.meta = {};
  process.env.APPROVAL_SECRET = "action-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "a@example.com", name: "Ada" });
});

afterEach(() => {
  delete process.env.APPROVAL_SECRET;
  delete process.env.APP_BASE_URL;
});

describe("agent prefs route", () => {
  it("GET shows an unconsented shopper with the S$60 default and the locked-on confirm toggle", async () => {
    const body = (await (await prefsGet()).json()) as { prefs: Record<string, unknown> };
    expect(body.prefs).toEqual({ consented: false, consentAt: null, capCents: 6000, askEveryOrder: true, paused: false });
  });

  it("POST with consent saves the cap and the consent time, and keeps unrelated prefs", async () => {
    db.meta = { agent_prefs: { lastNudgeSession: "nudge_x" } };
    const res = await prefsPost(post("/api/agent/prefs", { capCents: 10000, consent: true }));
    expect(res.status).toBe(200);
    const saved = db.meta.agent_prefs as Record<string, unknown>;
    expect(saved).toMatchObject({ capCents: 10000, lastNudgeSession: "nudge_x" });
    expect(typeof saved.consentAt).toBe("string");
    const body = (await res.json()) as { prefs: { consented: boolean; askEveryOrder: boolean } };
    expect(body.prefs).toMatchObject({ consented: true, askEveryOrder: true });
  });

  it("changing the cap later keeps the original consent time", async () => {
    db.meta = { agent_prefs: { consentAt: "2026-11-01T00:00:00.000Z", capCents: 3000 } };
    await prefsPost(post("/api/agent/prefs", { capCents: 6000, consent: true }));
    expect((db.meta.agent_prefs as Record<string, unknown>).consentAt).toBe("2026-11-01T00:00:00.000Z");
    await prefsPost(post("/api/agent/prefs", { capCents: 10000 }));
    expect(db.meta.agent_prefs).toMatchObject({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 10000 });
  });

  it("a cap alone does not grant consent", async () => {
    await prefsPost(post("/api/agent/prefs", { capCents: 3000 }));
    expect((db.meta.agent_prefs as Record<string, unknown>).consentAt).toBeUndefined();
  });

  it("rejects turning 'ask before every order' off, unknown keys, and caps outside the range", async () => {
    const bad = [
      { capCents: 6000, consent: true, askEveryOrder: false },
      { capCents: 6000, askEveryOrder: true },
      { capCents: MIN_CAP_CENTS - 1 },
      { capCents: MAX_CAP_CENTS + 1 },
      { capCents: 60.5 },
      { capCents: "6000" },
      { capCents: 6000, consent: false },
      { consent: true },
    ];
    for (const body of bad) {
      expect((await prefsPost(post("/api/agent/prefs", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(db.meta.agent_prefs).toBeUndefined();
  });

  it("requires a signed-in shopper, JSON, and the app origin", async () => {
    expect((await prefsPost(post("/api/agent/prefs", { capCents: 6000 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(db.meta.agent_prefs).toBeUndefined();
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await prefsPost(post("/api/agent/prefs", { capCents: 6000 }))).status).toBe(401);
    expect((await prefsGet()).status).toBe(401);
  });
});

describe("cap helpers", () => {
  it("accepts whole-cent caps in range and parses the Custom field", () => {
    expect(validCap(MIN_CAP_CENTS)).toBe(true);
    expect(validCap(MAX_CAP_CENTS)).toBe(true);
    expect(validCap(MIN_CAP_CENTS - 1)).toBe(false);
    expect(validCap(MAX_CAP_CENTS + 1)).toBe(false);
    expect(parseCustomCapDollars("45")).toBe(4500);
    expect(parseCustomCapDollars("S$45.50")).toBe(4550);
    expect(parseCustomCapDollars("4")).toBeNull();
    expect(parseCustomCapDollars("501")).toBeNull();
    expect(parseCustomCapDollars("-5")).toBeNull();
    expect(parseCustomCapDollars("12.345")).toBeNull();
    expect(parseCustomCapDollars("")).toBeNull();
  });
});

describe("place_order needs consent", () => {
  it("without consent, Confirm is refused, nothing is placed, and the same confirmation works after consent", async () => {
    setUp(undefined);
    const actionId = await pendingOrder();
    const refused = await confirmJson(actionId);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("consent_required");
    expect(db.meta.orders).toBeUndefined();
    expect(nonces.ids.size).toBe(1);

    await prefsPost(post("/api/agent/prefs", { capCents: 6000, consent: true }));
    const placed = await confirmJson(actionId);
    expect(placed.status).toBe(200);
    expect(placed.body.order).toMatchObject({ totalCents: ETHIOPIA_TOTAL });
  });

  it("a stored cap without consentAt is still no consent", async () => {
    setUp({ capCents: 10000 });
    expect((await confirmJson(await pendingOrder())).body.error).toBe("consent_required");
  });
});

describe("spending cap per order", () => {
  it("places an order whose total equals the cap exactly", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: ETHIOPIA_TOTAL });
    const { status, body } = await confirmJson(await pendingOrder());
    expect(status).toBe(200);
    expect(body.overCap).toBeUndefined();
    expect(body.order).toBeDefined();
  });

  it("one cent over the cap places nothing and signs a second 'Place it anyway?' step", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: ETHIOPIA_TOTAL - 1 });
    const first = await confirmJson(await pendingOrder());
    expect(first.status).toBe(200);
    expect(first.body.order).toBeUndefined();
    const over = first.body.overCap as { actionId: string; summary: string; totalCents: number; capCents: number };
    expect(over.summary).toMatch(/^Place it anyway\?/);
    expect(over).toMatchObject({ totalCents: ETHIOPIA_TOTAL, capCents: ETHIOPIA_TOTAL - 1 });
    expect(db.meta.orders).toBeUndefined();
    expect((db.meta.cart as { items: unknown[] }).items).toHaveLength(1);
  });

  it("confirming the 'anyway' step places the order, once, and the first token is spent", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 1000 });
    const firstId = await pendingOrder();
    const first = await confirmJson(firstId);
    const over = first.body.overCap as { actionId: string };
    expect((await confirmJson(firstId)).status).toBe(409);

    const placed = await confirmJson(over.actionId);
    expect(placed.status).toBe(200);
    expect(placed.body.order).toMatchObject({ totalCents: ETHIOPIA_TOTAL });
    expect((db.meta.orders as unknown[]).length).toBe(1);
    expect((await confirmJson(over.actionId)).status).toBe(409);
  });

  it("the 'anyway' step is void if the cart changes after it was signed", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 1000 });
    const over = (await confirmJson(await pendingOrder())).body.overCap as { actionId: string };
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 1000 }, [{ productId: "ethiopia-250", qty: 3 }]);
    const res = await confirmJson(over.actionId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("cart_changed");
    expect(db.meta.orders).toBeUndefined();
  });

  it("nobody can ask the server to sign an 'anyway' order directly", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 1000 });
    expect(await proposeAction(SUB, { op: "place_order", anyway: true })).toEqual({ error: "invalid_body" });
  });

  it("the 'anyway' step still needs consent", async () => {
    setUp({ capCents: 1000 });
    const forged = await proposeAction(SUB, { op: "place_order", anyway: true }, { overCap: true });
    if (!("actionId" in forged)) throw new Error("expected pending");
    const res = await confirmJson(forged.actionId);
    expect(res.status).toBe(403);
    expect(db.meta.orders).toBeUndefined();
  });
});

describe("test-only payment mock", () => {
  it("an order placed through Confirm records payment { mode: 'test', ref } and nothing card-like", async () => {
    setUp({ consentAt: "2026-11-01T00:00:00.000Z", capCents: 6000 });
    const { body } = await confirmJson(await pendingOrder());
    expect(body.order).toBeDefined();
    const stored = (db.meta.orders as Record<string, unknown>[])[0];
    expect(stored?.payment).toEqual({ mode: "test", ref: expect.stringMatching(/^test_[0-9a-f]{12}$/) });
    expect(Object.keys(stored ?? {}).filter((key) => /card|pan|cvv|token/i.test(key))).toEqual([]);
    expect((await listOrders(SUB))[0]?.payment).toEqual(stored?.payment);
  });

  it("only well-formed test payments are read back", () => {
    const made = createTestPayment();
    expect(readTestPayment(made)).toEqual(made);
    expect(readTestPayment({ mode: "live", ref: made.ref })).toBeUndefined();
    expect(readTestPayment({ mode: "test", ref: "4242424242424242" })).toBeUndefined();
    expect(readTestPayment(null)).toBeUndefined();
  });
});
