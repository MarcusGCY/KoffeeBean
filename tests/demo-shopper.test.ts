import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  meta: {} as Record<string, unknown>,
  patches: [] as { userId: string; patch: Record<string, unknown> }[],
  reads: [] as string[],
}));
const readAdminMock = vi.hoisted(() => vi.fn());
const neonMock = vi.hoisted(() => vi.fn());

vi.mock("@neondatabase/serverless", () => ({ neon: neonMock }));
vi.mock("@/lib/demo-session", () => ({ readAdmin: readAdminMock }));
vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async (userId: string) => {
    db.reads.push(userId);
    return structuredClone(db.meta);
  },
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    db.patches.push({ userId, patch: structuredClone(patch) });
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
}));

import { POST } from "@/app/api/demo/bi-seed/route";
import {
  DEMO_SHOPPER_ORDER_PREFIX,
  DemoShopperError,
  buildDemoShopperOrders,
  seedDemoShopperOrders,
} from "@/lib/bi-demo-seed";
import { demoCsrfToken } from "@/lib/demo-auth";
import { demoShopperSub, isDemoShopperSub } from "@/lib/demo-shopper";
import { isTestShopper } from "@/lib/bi-track";
import { listOrders, normalizeAgentPrefs, normalizeShopperFlags } from "@/lib/store-meta";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const DEMO_SUB = "auth0|demo-shopper";

beforeEach(() => {
  db.meta = {};
  db.patches = [];
  db.reads = [];
});

afterEach(() => {
  delete process.env.DEMO_SHOPPER_SUB;
  delete process.env.BI_HASH_SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.APPROVAL_SECRET;
  readAdminMock.mockReset();
  neonMock.mockReset();
});

describe("normalizeAgentPrefs", () => {
  it("defaults every field when agent_prefs is missing or not an object", () => {
    const defaults = { capCents: 6000, askEveryOrder: true };
    expect(normalizeAgentPrefs(undefined)).toEqual(defaults);
    expect(normalizeAgentPrefs(null)).toEqual(defaults);
    expect(normalizeAgentPrefs("yes")).toEqual(defaults);
    expect(normalizeAgentPrefs([])).toEqual(defaults);
    expect(normalizeAgentPrefs({})).toEqual(defaults);
  });

  it("keeps valid stored fields", () => {
    const stored = {
      consentAt: "2026-11-01T10:00:00.000Z",
      capCents: 2500,
      askEveryOrder: true,
      snoozeUntil: "2026-11-30T00:00:00.000Z",
      lastNudgeSession: "sess-1",
      paused: true,
    };
    expect(normalizeAgentPrefs(stored)).toEqual(stored);
  });

  it("locks askEveryOrder to true", () => {
    expect(normalizeAgentPrefs({ askEveryOrder: false }).askEveryOrder).toBe(true);
  });

  it("falls back to defaults for malformed fields", () => {
    const prefs = normalizeAgentPrefs({
      capCents: "5000",
      consentAt: "not a date",
      snoozeUntil: 12,
      lastNudgeSession: "",
      paused: "yes",
    });
    expect(prefs).toEqual({ capCents: 6000, askEveryOrder: true });
    expect(normalizeAgentPrefs({ capCents: -1 }).capCents).toBe(6000);
    expect(normalizeAgentPrefs({ capCents: 0 }).capCents).toBe(6000);
    expect(normalizeAgentPrefs({ capCents: 10.5 }).capCents).toBe(6000);
  });
});

describe("normalizeShopperFlags and isTestShopper", () => {
  it("reads an old account with neither key as not a test shopper with default prefs", () => {
    expect(normalizeShopperFlags({ cart: { items: [] } })).toEqual({
      isTest: false,
      agentPrefs: { capCents: 6000, askEveryOrder: true },
    });
  });

  it("treats only a stored boolean true as is_test", () => {
    expect(normalizeShopperFlags({ is_test: true }).isTest).toBe(true);
    expect(normalizeShopperFlags({ is_test: "true" }).isTest).toBe(false);
    expect(normalizeShopperFlags({ is_test: 1 }).isTest).toBe(false);
  });

  it("isTestShopper follows app_metadata.is_test", () => {
    expect(isTestShopper({}, "auth0|someone")).toBe(false);
    expect(isTestShopper({ is_test: true }, "auth0|someone")).toBe(true);
  });

  it("isTestShopper is true for the configured demo shopper whatever the metadata says", () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    expect(isTestShopper({}, DEMO_SUB)).toBe(true);
    expect(isTestShopper({}, "auth0|someone")).toBe(false);
    expect(isTestShopper({})).toBe(false);
  });
});

describe("demo shopper config", () => {
  it("is unset by default and never matches", () => {
    expect(demoShopperSub()).toBeNull();
    expect(isDemoShopperSub("")).toBe(false);
    expect(isDemoShopperSub(DEMO_SUB)).toBe(false);
  });

  it("reads DEMO_SHOPPER_SUB, trimmed", () => {
    process.env.DEMO_SHOPPER_SUB = `  ${DEMO_SUB} `;
    expect(demoShopperSub()).toBe(DEMO_SUB);
    expect(isDemoShopperSub(DEMO_SUB)).toBe(true);
  });
});

describe("buildDemoShopperOrders", () => {
  it("builds Ethiopia 250g about 12 days ago plus an older order, all marked demo", () => {
    const orders = buildDemoShopperOrders(NOW);
    expect(orders).toHaveLength(2);
    const [recent, older] = orders;
    expect(recent?.items).toEqual([
      { productId: "ethiopia-250", name: "Ethiopia Yirgacheffe 250g", unitPriceCents: 1800, qty: 1 },
    ]);
    expect(NOW.getTime() - Date.parse(recent!.createdAt)).toBe(12 * 24 * 3_600_000);
    expect(Date.parse(older!.createdAt)).toBeLessThan(Date.parse(recent!.createdAt));
    for (const order of orders) {
      expect(order.demo).toBe(true);
      expect(order.id.startsWith(DEMO_SHOPPER_ORDER_PREFIX)).toBe(true);
      expect(order.cancelledAt).toBeNull();
      expect(order.totalCents).toBe(order.subtotalCents - order.discountCents + order.taxCents);
    }
    expect(new Set(orders.map((order) => order.id)).size).toBe(2);
  });
});

describe("seedDemoShopperOrders", () => {
  it("refuses when no demo shopper is configured, before any Auth0 call", async () => {
    await expect(seedDemoShopperOrders(DEMO_SUB, NOW)).rejects.toMatchObject({ reason: "not_configured" });
    expect(db.reads).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it("refuses any sub other than the configured demo shopper", async () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    await expect(seedDemoShopperOrders("auth0|someone-else", NOW)).rejects.toBeInstanceOf(DemoShopperError);
    expect(db.reads).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it("writes only orders and is_test for the demo shopper, readable as orders", async () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    const result = await seedDemoShopperOrders(DEMO_SUB, NOW);
    expect(result).toEqual({ seeded: 2, replaced: 0 });
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0]?.userId).toBe(DEMO_SUB);
    expect(Object.keys(db.patches[0]?.patch ?? {}).sort()).toEqual(["is_test", "orders"]);
    expect(db.meta.is_test).toBe(true);
    const stored = db.meta.orders as { demo?: boolean }[];
    expect(stored.every((row) => row.demo === true)).toBe(true);

    const listed = await listOrders(DEMO_SUB, NOW);
    expect(listed.map((order) => order.status)).toEqual(["delivered", "delivered"]);
  });

  it("re-seeding replaces demo rows, keeps real orders untouched, and stays newest first", async () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    const real = {
      id: "BB-REAL1",
      createdAt: "2026-11-20T09:00:00.000Z",
      cancelledAt: null,
      subtotalCents: 1400,
      discountCents: 0,
      taxCents: 112,
      totalCents: 1512,
      coupon: null,
      items: [{ productId: "mug", name: "BeanBox Ceramic Mug", unitPriceCents: 1400, qty: 1 }],
    };
    db.meta = {
      orders: [real, { ...real, id: "BB-DEMO-STALE", demo: true, createdAt: "2026-01-01T00:00:00.000Z" }],
      cart: { items: [{ productId: "mug", qty: 1 }], coupon: null },
    };
    const first = await seedDemoShopperOrders(DEMO_SUB, NOW);
    expect(first).toEqual({ seeded: 2, replaced: 1 });
    const second = await seedDemoShopperOrders(DEMO_SUB, NOW);
    expect(second).toEqual({ seeded: 2, replaced: 2 });

    const stored = db.meta.orders as { id: string }[];
    expect(stored.map((row) => row.id)).toEqual(["BB-REAL1", "BB-DEMO-ETHIOPIA", "BB-DEMO-OLDER"]);
    expect(stored[0]).toEqual(real);
    expect(db.meta.cart).toEqual({ items: [{ productId: "mug", qty: 1 }], coupon: null });
    expect(db.patches.every((entry) => !("cart" in entry.patch))).toBe(true);
  });
});

describe("POST /api/demo/bi-seed demo shopper", () => {
  const ADMIN = { id: "auth0|admin1", email: "owner@example.com" };

  function request(csrf: string) {
    return new Request("http://localhost/api/demo/bi-seed", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ csrf }),
    });
  }

  beforeEach(() => {
    process.env.APPROVAL_SECRET = "test-approval-secret-0123456789";
    process.env.BI_HASH_SECRET = "test-bi-hash-secret-0123456789";
    process.env.DATABASE_URL = "postgres://user:pw@demo-shopper.example/neondb";
    neonMock.mockReturnValue(
      Object.assign(vi.fn(), {
        transaction: vi.fn(() => Promise.resolve([])),
        query: vi.fn(),
      }),
    );
  });

  it("does not write Auth0 when no demo shopper is configured", async () => {
    readAdminMock.mockResolvedValue(ADMIN);
    const res = await POST(request(demoCsrfToken(ADMIN.id)));
    expect(res.status).toBe(200);
    expect(db.patches).toEqual([]);
  });

  it("seeds only the configured demo shopper for an admin", async () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    readAdminMock.mockResolvedValue(ADMIN);
    const res = await POST(request(demoCsrfToken(ADMIN.id)));
    expect(res.status).toBe(200);
    expect(db.patches.map((entry) => entry.userId)).toEqual([DEMO_SUB]);
  });

  it("writes nothing without an admin session", async () => {
    process.env.DEMO_SHOPPER_SUB = DEMO_SUB;
    readAdminMock.mockResolvedValue(null);
    const res = await POST(request("x"));
    expect(res.status).toBe(404);
    expect(db.patches).toEqual([]);
  });
});
