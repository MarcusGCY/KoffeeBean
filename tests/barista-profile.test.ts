import { beforeEach, describe, expect, it, vi } from "vitest";
import products from "@/data/products.json";
import {
  META_BUDGET_BYTES,
  PROFILE_MAX_BYTES,
  computeProfile,
  emptyProfile,
  fitProfile,
  normalizeProfile,
  profileBytes,
  profileIsStale,
  profilePatch,
  type BaristaProfile,
} from "@/lib/barista-profile";
import { clearLocation, grantLocation } from "@/lib/location-consent";
import { estimateReorder, suggestNextBean, type NudgeOrder, type NudgeProduct } from "@/lib/reorder-nudge";
import { cancelOrder, placeOrder, readBaristaProfile } from "@/lib/store-meta";

const SUB = "auth0|shopper";
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, patches: [] as Record<string, unknown>[] }));

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

const catalog = products as NudgeProduct[];
const BASE = Date.UTC(2026, 8, 1);
const DAY = 24 * 60 * 60 * 1000;
const at = (day: number) => new Date(BASE + day * DAY).toISOString();
const order = (id: string, day: number, items: [string, number][], cancelled = false): NudgeOrder & { id: string } => ({
  id,
  createdAt: at(day),
  cancelledAt: cancelled ? at(day + 0.01) : null,
  items: items.map(([productId, qty]) => ({ productId, qty })),
});

const HISTORY = [
  order("A", 0, [["ethiopia-250", 2]]),
  order("B", 20, [
    ["ethiopia-250", 1],
    ["mug", 1],
  ]),
  order("C", 40, [["colombia-250", 2]]),
];
const NOW = new Date(BASE + 45 * DAY);

function stored(o: NudgeOrder & { id: string }) {
  return {
    ...o,
    subtotalCents: 1000,
    discountCents: 0,
    taxCents: 0,
    totalCents: 1000,
    coupon: null,
    items: o.items.map((item) => ({ ...item, name: item.productId, unitPriceCents: 500 })),
  };
}

beforeEach(() => {
  db.meta = {};
  db.patches = [];
  delete process.env.DATABASE_URL;
});

describe("computeProfile", () => {
  it("learns top products, roast, cadence and pace from non-cancelled orders", () => {
    const profile = computeProfile(HISTORY, { now: NOW });
    expect(profile.v).toBe(1);
    expect(profile.updatedAt).toBe(NOW.toISOString());
    expect(profile.topProducts).toEqual(["ethiopia-250", "colombia-250", "mug"]);
    expect(profile.preferredRoast).toBe("light");
    expect(profile.cadenceDays).toBe(20);
    // 500 g over 20 days = 25 g/day, 250 g over 20 days = 12.5 g/day; median 18.75 rounds to 19.
    expect(profile.gramsPerDay).toBe(19);
  });

  it("reuses estimateReorder for nextDue and suggestNextBean for nextBean", () => {
    const profile = computeProfile(HISTORY, { now: NOW });
    const estimate = estimateReorder(HISTORY, catalog, { now: NOW, gramsPerDay: profile.gramsPerDay });
    expect(estimate?.estimatedDaysLeft).toBe(22);
    expect(profile.nextDue).toBe("2026-11-07");
    expect(Date.parse(profile.nextDue as string)).toBe(Date.parse(estimate!.orderedAt.slice(0, 10)) + (estimate!.daysSinceOrder + estimate!.estimatedDaysLeft) * DAY);
    expect(profile.nextBean).toBe(suggestNextBean(HISTORY, catalog, [], { now: NOW })?.productId);
  });

  it("ignores cancelled orders, unknown products and non-integer quantities", () => {
    const profile = computeProfile(
      [
        order("A", 0, [["espresso-1kg", 3]], true),
        order("B", 10, [["not-a-product", 4]]),
        order("C", 12, [["colombia-250", 1.5]]),
        order("D", 14, [["tote", 1]]),
      ],
      { now: NOW },
    );
    expect(profile.topProducts).toEqual(["tote"]);
    expect(profile.preferredRoast).toBeNull();
    expect(profile.cadenceDays).toBeNull();
    expect(profile.nextDue).toBeUndefined();
  });

  it("has no cadence with a single bean order and falls back to the default pace", () => {
    const profile = computeProfile([HISTORY[0]!], { now: NOW });
    expect(profile.cadenceDays).toBeNull();
    expect(profile.gramsPerDay).toBe(15);
  });

  it("carries the district only when one is given", () => {
    expect(computeProfile(HISTORY, { now: NOW }).district).toBeUndefined();
    expect(computeProfile(HISTORY, { now: NOW, district: "23" }).district).toBe("23");
    expect(computeProfile(HISTORY, { now: NOW, district: "238823" }).district).toBeUndefined();
  });

  it("keeps fields the shopper corrected when it recomputes", () => {
    const previous: BaristaProfile = { ...computeProfile(HISTORY, { now: NOW }), cadenceDays: 7, preferredRoast: "dark", edited: ["cadenceDays", "preferredRoast"] };
    const next = computeProfile(HISTORY, { now: new Date(NOW.getTime() + DAY), previous });
    expect(next.cadenceDays).toBe(7);
    expect(next.preferredRoast).toBe("dark");
    expect(next.gramsPerDay).toBe(19);
    expect(next.edited).toEqual(["cadenceDays", "preferredRoast"]);
  });

  it("holds only enums and numbers: nothing from a name or an email can appear", () => {
    const profile = computeProfile(HISTORY, { now: NOW, district: "23" });
    const ids = new Set(catalog.map((p) => p.id));
    expect(profile.topProducts.every((id) => ids.has(id))).toBe(true);
    expect(Object.keys(profile).sort()).toEqual(
      ["cadenceDays", "district", "gramsPerDay", "nextBean", "nextDue", "preferredRoast", "topProducts", "updatedAt", "v"].sort(),
    );
  });
});

describe("size and normalization", () => {
  it("stays within 2 KB even for the busiest history", () => {
    const busy = catalog.map((p, i) => order(`O${i}`, i * 3, [[p.id, 9]]));
    const profile = computeProfile(busy, { now: NOW, district: "23" });
    expect(profile.topProducts).toHaveLength(5);
    expect(profileBytes(profile)).toBeLessThanOrEqual(PROFILE_MAX_BYTES);
  });

  it("fitProfile trims the list, then optional fields, until it fits", () => {
    const huge: BaristaProfile = {
      ...emptyProfile(NOW),
      topProducts: Array.from({ length: 5 }, (_, i) => `${"x".repeat(500)}${i}`),
      nextBean: "y".repeat(500),
    };
    const fitted = fitProfile(huge);
    expect(profileBytes(fitted)).toBeLessThanOrEqual(PROFILE_MAX_BYTES);
    expect(fitted.topProducts.length).toBeLessThan(5);
  });

  it("normalizeProfile reads a good profile and rejects malformed, foreign or oversize ones", () => {
    const good = computeProfile(HISTORY, { now: NOW, district: "23" });
    expect(normalizeProfile(structuredClone(good))).toEqual(good);
    for (const bad of [
      null,
      [],
      { ...good, v: 2 },
      { ...good, updatedAt: "soon" },
      { ...good, topProducts: "ethiopia-250" },
      { ...good, cadenceDays: 0 },
      { ...good, gramsPerDay: "lots" },
      { ...good, preferredRoast: "burnt" },
    ]) {
      expect(normalizeProfile(bad)).toBeNull();
    }
    expect(normalizeProfile({ ...good, district: "238823" })?.district).toBeUndefined();
    expect(normalizeProfile({ ...good, topProducts: ["nope", "mug", "mug"] })?.topProducts).toEqual(["mug"]);
    expect(normalizeProfile({ ...good, pad: "z".repeat(5000) })).toEqual(good);
  });

  it("goes stale after 24 hours", () => {
    const profile = emptyProfile(NOW);
    expect(profileIsStale(profile, new Date(NOW.getTime() + DAY))).toBe(false);
    expect(profileIsStale(profile, new Date(NOW.getTime() + DAY + 1))).toBe(true);
    expect(profileIsStale(profile, new Date(NOW.getTime() - 1))).toBe(true);
  });
});

describe("profilePatch and the Auth0 16 KB cap", () => {
  it("writes nothing for a shopper with no orders and no profile", () => {
    expect(profilePatch({}, [], NOW)).toEqual({});
  });

  it("leaves a personalization-off profile alone", () => {
    const meta = { barista_profile: { ...emptyProfile(NOW), off: true } };
    expect(profilePatch(meta, HISTORY, NOW)).toEqual({});
  });

  it("is skipped, not the order, when the combined metadata would pass the budget", () => {
    const meta = { audit: "x".repeat(META_BUDGET_BYTES) };
    expect(profilePatch(meta, HISTORY, NOW)).toEqual({});
    expect(profilePatch({ audit: "x".repeat(META_BUDGET_BYTES - 3000) }, HISTORY, NOW).barista_profile).toBeDefined();
  });

  it("counts the keys the same patch is already writing", () => {
    const other = { orders: "x".repeat(META_BUDGET_BYTES) };
    expect(profilePatch({}, HISTORY, NOW, other)).toEqual({});
  });
});

describe("recompute on order place and cancel, and lazily", () => {
  const cart = { items: [{ productId: "ethiopia-250", qty: 2 }], coupon: null };

  it("rewrites the profile inside the same patch as the placed order", async () => {
    db.meta = { cart };
    const placed = await placeOrder(SUB, NOW);
    expect("error" in placed).toBe(false);
    expect(db.patches).toHaveLength(1);
    const patch = db.patches[0]!;
    expect(Object.keys(patch)).toContain("orders");
    const profile = patch.barista_profile as BaristaProfile;
    expect(profile.topProducts).toEqual(["ethiopia-250"]);
    expect(profile.updatedAt).toBe(NOW.toISOString());
    expect(profile.nextDue).toBe(
      new Date(NOW.getTime() + Math.ceil(500 / 15) * DAY).toISOString().slice(0, 10),
    );
  });

  it("recomputes without a cancelled order", async () => {
    db.meta = { cart };
    const placed = (await placeOrder(SUB, NOW)) as { id: string };
    expect((db.meta.barista_profile as BaristaProfile).topProducts).toEqual(["ethiopia-250"]);
    db.patches = [];
    const cancelled = await cancelOrder(SUB, placed.id, new Date(NOW.getTime() + 60_000));
    expect("error" in cancelled).toBe(false);
    expect(db.patches).toHaveLength(1);
    const profile = db.patches[0]!.barista_profile as BaristaProfile;
    expect(profile.topProducts).toEqual([]);
    expect(profile.nextDue).toBeUndefined();
  });

  it("still places the order when the profile cannot fit", async () => {
    db.meta = { cart, audit: "x".repeat(META_BUDGET_BYTES) };
    const placed = await placeOrder(SUB, NOW);
    expect("error" in placed).toBe(false);
    expect(db.patches[0]).toHaveProperty("orders");
    expect(db.patches[0]).not.toHaveProperty("barista_profile");
  });

  it("does not recompute a profile under 24 hours old", async () => {
    const fresh = computeProfile(HISTORY, { now: NOW });
    db.meta = { orders: HISTORY.map(stored), barista_profile: fresh };
    expect(await readBaristaProfile(SUB, new Date(NOW.getTime() + 23 * 60 * 60 * 1000))).toEqual(fresh);
    expect(db.patches).toHaveLength(0);
  });

  it("recomputes a profile older than 24 hours and saves only that key", async () => {
    const old = { ...computeProfile(HISTORY, { now: NOW }), topProducts: ["mug"] };
    db.meta = { orders: HISTORY.map(stored), barista_profile: old, agent_prefs: { capCents: 6000 } };
    const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const profile = await readBaristaProfile(SUB, later);
    expect(profile?.topProducts).toEqual(["ethiopia-250", "colombia-250", "mug"]);
    expect(profile?.updatedAt).toBe(later.toISOString());
    expect(db.patches).toHaveLength(1);
    expect(Object.keys(db.patches[0]!)).toEqual(["barista_profile"]);
  });

  it("builds a missing profile lazily, and stays empty for a shopper with no orders", async () => {
    db.meta = { orders: HISTORY.map(stored) };
    expect((await readBaristaProfile(SUB, NOW))?.preferredRoast).toBe("light");
    db.meta = {};
    db.patches = [];
    expect(await readBaristaProfile(SUB, NOW)).toBeNull();
    expect(db.patches).toHaveLength(0);
  });

  it("never recomputes once personalization is off", async () => {
    const off = { ...emptyProfile(new Date(NOW.getTime() - 5 * DAY)), off: true as const };
    db.meta = { orders: HISTORY.map(stored), barista_profile: off };
    expect(await readBaristaProfile(SUB, NOW)).toEqual(off);
    expect(db.patches).toHaveLength(0);
  });
});

describe("location consent and the profile district", () => {
  it("adds the district to an existing profile on opt-in and removes it on withdrawal", async () => {
    db.meta = { orders: HISTORY.map(stored), barista_profile: computeProfile(HISTORY, { now: NOW }) };
    await grantLocation(SUB, "238823", NOW);
    expect((db.meta.barista_profile as BaristaProfile).district).toBe("23");
    expect(JSON.stringify(db.meta.barista_profile)).not.toContain("238823");
    await clearLocation(SUB);
    expect(db.meta.location).toBeUndefined();
    expect((db.meta.barista_profile as BaristaProfile).district).toBeUndefined();
  });

  it("does not invent a profile when there is none", async () => {
    await grantLocation(SUB, "238823", NOW);
    expect(db.meta.barista_profile).toBeUndefined();
  });

  it("a recompute only carries a district while consent is active", () => {
    const meta = {
      location: { postcode: "238823", consentAt: NOW.toISOString(), purpose: "area-personalisation" },
    };
    expect(profilePatch(meta, HISTORY, NOW).barista_profile?.district).toBe("23");
    expect(profilePatch({}, HISTORY, NOW).barista_profile?.district).toBeUndefined();
  });
});
