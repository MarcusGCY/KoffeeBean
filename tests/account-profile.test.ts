import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH } from "@/app/api/account/profile/route";
import { emptyProfile, normalizeProfile, type BaristaProfile } from "@/lib/barista-profile";
import { profilePromptMessage } from "@/lib/profile-prompt";
import { getShopper } from "@/lib/shopper";
import { placeOrder, readBaristaProfile } from "@/lib/store-meta";
import type { ProfileView } from "@/lib/profile-text";

const SUB = "auth0|shopper";
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, users: new Set<string>() }));

vi.mock("@/lib/auth0-mgmt", () => ({
  mgmtConfigured: () => true,
  getAppMetadata: async (userId: string) => {
    db.users.add(userId);
    return structuredClone(db.meta);
  },
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    db.users.add(userId);
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

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const row = (id: string, days: number, productId: string, qty: number) => ({
  id,
  createdAt: ago(days),
  cancelledAt: null,
  subtotalCents: 1000,
  discountCents: 0,
  taxCents: 0,
  totalCents: 1000,
  coupon: null,
  items: [{ productId, name: "Bean", unitPriceCents: 500, qty }],
});
const ORDERS = [row("C", 5, "colombia-250", 2), row("B", 25, "ethiopia-250", 1), row("A", 45, "ethiopia-250", 2)];
const LOCATION = { postcode: "238823", consentAt: ago(30), purpose: "area-personalisation" };

function call(method: "PATCH" | "DELETE" | "GET", body?: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) {
  const req = new Request("http://localhost/api/account/profile", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return method === "GET" ? GET() : method === "PATCH" ? PATCH(req) : DELETE(req);
}

async function view(res: Response) {
  return ((await res.json()) as { profile: ProfileView }).profile;
}

const toolsAudited = () => ((db.meta.audit as { tool: string }[] | undefined) ?? []).map((entry) => entry.tool);
const stored = () => normalizeProfile(db.meta.barista_profile) as BaristaProfile;

beforeEach(() => {
  db.meta = { orders: structuredClone(ORDERS), location: LOCATION };
  db.users.clear();
  process.env.APP_BASE_URL = "http://localhost:3000";
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "ada@example.com", name: "Ada" });
});

describe("GET /api/account/profile", () => {
  it("shows what Barista knows, with product names and only the 2-digit district", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    const profile = await view(res);
    expect(profile).toMatchObject({
      personalization: "on",
      hasData: true,
      preferredRoast: "light",
      district: "23",
      edited: [],
    });
    expect(profile.topProducts.map((p) => p.name)).toEqual(["Ethiopia Yirgacheffe 250g", "Colombia Huila 250g"]);
    const text = JSON.stringify(profile);
    expect(text).not.toContain("238823");
    expect(text).not.toContain("ada@example.com");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says nothing yet for a shopper with no orders, and writes nothing", async () => {
    db.meta = {};
    const profile = await view(await call("GET"));
    expect(profile).toMatchObject({ hasData: false, topProducts: [], preferredRoast: null, district: null });
    expect(db.meta.barista_profile).toBeUndefined();
  });

  it("requires a signed-in shopper", async () => {
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await call("GET")).status).toBe(401);
  });
});

describe("PATCH: edit", () => {
  it("lets the shopper correct roast, cadence and pace, and marks them as theirs", async () => {
    const res = await call("PATCH", { preferredRoast: "dark", cadenceDays: 10, gramsPerDay: 25 });
    expect(res.status).toBe(200);
    const profile = await view(res);
    expect(profile).toMatchObject({ preferredRoast: "dark", cadenceDays: 10, gramsPerDay: 25 });
    expect(profile.edited.sort()).toEqual(["cadenceDays", "gramsPerDay", "preferredRoast"]);
    expect(stored().edited?.sort()).toEqual(["cadenceDays", "gramsPerDay", "preferredRoast"]);
    // 500 g bought 5 days ago at 25 g/day: 20 days of supply, 15 left.
    expect(profile.nextDue).toBe(new Date(Date.parse(ago(5).slice(0, 10)) + 20 * DAY).toISOString().slice(0, 10));
  });

  it("keeps a correction when the profile is recomputed after 24 hours, and still learns the rest", async () => {
    await call("PATCH", { preferredRoast: "dark" });
    db.meta.barista_profile = { ...stored(), updatedAt: ago(3), topProducts: ["mug"] };
    const profile = await readBaristaProfile(SUB, NOW);
    expect(profile?.preferredRoast).toBe("dark");
    expect(profile?.topProducts).toEqual(["ethiopia-250", "colombia-250"]);
  });

  it("accepts null to say 'not sure' for cadence and roast", async () => {
    const profile = await view(await call("PATCH", { cadenceDays: null, preferredRoast: null }));
    expect(profile).toMatchObject({ cadenceDays: null, preferredRoast: null });
    expect(profile.edited.sort()).toEqual(["cadenceDays", "preferredRoast"]);
  });

  it("rejects bad values, unknown keys, an empty body, and mixing the switch with edits", async () => {
    for (const body of [
      {},
      { preferredRoast: "burnt" },
      { cadenceDays: 0 },
      { cadenceDays: 181 },
      { cadenceDays: 7.5 },
      { cadenceDays: "7" },
      { gramsPerDay: 0 },
      { gramsPerDay: 101 },
      { gramsPerDay: null },
      { topProducts: ["mug"] },
      { district: "99" },
      { userId: "auth0|other", cadenceDays: 7 },
      { personalization: "maybe" },
      { personalization: "off", cadenceDays: 7 },
    ]) {
      expect((await call("PATCH", body)).status).toBe(400);
    }
    expect(db.meta.barista_profile).toBeUndefined();
    expect(toolsAudited()).toEqual([]);
  });

  it("does nothing, and audits nothing, when the values are already what Barista has", async () => {
    const before = await view(await call("GET"));
    const res = await call("PATCH", { preferredRoast: before.preferredRoast });
    expect(res.status).toBe(200);
    expect((await res.json()) as { unchanged?: boolean }).toMatchObject({ unchanged: true });
    expect(toolsAudited()).toEqual([]);
  });
});

describe("PATCH: personalization", () => {
  it("off clears what was learned, stores only the off marker, and Barista stops using it", async () => {
    await call("GET");
    const res = await call("PATCH", { personalization: "off" });
    expect(res.status).toBe(200);
    expect(await view(res)).toMatchObject({ personalization: "off", hasData: false, topProducts: [], district: "23" });
    expect(stored()).toMatchObject({ off: true, topProducts: [], preferredRoast: null, cadenceDays: null });
    expect(stored().district).toBeUndefined();
    expect(profilePromptMessage(await readBaristaProfile(SUB, NOW))).toBeNull();
  });

  it("stays off through lazy refreshes and new orders", async () => {
    await call("PATCH", { personalization: "off" });
    db.meta.barista_profile = { ...stored(), updatedAt: ago(10) };
    expect((await readBaristaProfile(SUB, NOW))?.off).toBe(true);
    db.meta.cart = { items: [{ productId: "ethiopia-250", qty: 1 }], coupon: null };
    const placed = await placeOrder(SUB, NOW);
    expect("error" in placed).toBe(false);
    expect(stored().off).toBe(true);
    expect(stored().topProducts).toEqual([]);
  });

  it("refuses edits while off", async () => {
    await call("PATCH", { personalization: "off" });
    const res = await call("PATCH", { cadenceDays: 9 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "personalization_off" });
  });

  it("on relearns from orders", async () => {
    await call("PATCH", { personalization: "off" });
    const profile = await view(await call("PATCH", { personalization: "on" }));
    expect(profile).toMatchObject({ personalization: "on", hasData: true, preferredRoast: "light" });
    expect(stored().off).toBeUndefined();
  });

  it("is a no-op when already in that state", async () => {
    const res = await call("PATCH", { personalization: "on" });
    expect(((await res.json()) as { unchanged?: boolean }).unchanged).toBe(true);
    expect(toolsAudited()).toEqual([]);
  });
});

describe("DELETE: reset", () => {
  it("clears corrections and relearns from orders", async () => {
    await call("PATCH", { preferredRoast: "dark", cadenceDays: 3, gramsPerDay: 40 });
    const res = await call("DELETE", {});
    expect(res.status).toBe(200);
    const profile = await view(res);
    expect(profile).toMatchObject({ preferredRoast: "light", edited: [] });
    expect(profile.cadenceDays).not.toBe(3);
    expect(stored().edited).toBeUndefined();
  });

  it("does not turn personalization back on", async () => {
    await call("PATCH", { personalization: "off" });
    const profile = await view(await call("DELETE", {}));
    expect(profile.personalization).toBe("off");
    expect(stored().off).toBe(true);
  });

  it("needs a same-origin JSON write", async () => {
    expect((await call("DELETE", {}, { origin: "http://evil.example" })).status).toBe(403);
    expect((await call("DELETE", {}, {})).status).toBe(403);
    expect((await call("PATCH", { cadenceDays: 9 }, { origin: "http://evil.example" })).status).toBe(403);
    expect(db.meta.barista_profile).toBeUndefined();
  });
});

describe("audit and scoping", () => {
  it("writes one audit row for each change and none for a read", async () => {
    await call("GET");
    expect(toolsAudited()).toEqual([]);
    await call("PATCH", { preferredRoast: "dark" });
    await call("PATCH", { personalization: "off" });
    await call("PATCH", { personalization: "on" });
    await call("DELETE", {});
    expect(toolsAudited()).toEqual([
      "profile.edit",
      "profile.personalization_off",
      "profile.personalization_on",
      "profile.reset",
    ]);
    const text = JSON.stringify(db.meta.audit);
    expect(text).not.toContain("238823");
    expect(text).not.toContain("ada@example.com");
    expect((db.meta.audit as { summary: string }[])[0]!.summary).toBe("Corrected preferredRoast");
  });

  it("only reads and writes the signed-in shopper, never an id from the request", async () => {
    await call("PATCH", { cadenceDays: 9 });
    await call("DELETE", {});
    expect([...db.users]).toEqual([SUB]);
  });

  it("an off profile built elsewhere is honoured by the view", async () => {
    db.meta.barista_profile = { ...emptyProfile(NOW), off: true };
    expect((await view(await call("GET"))).personalization).toBe("off");
  });
});
