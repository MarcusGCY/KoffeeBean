import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as activityGet } from "@/app/api/agent/activity/route";
import { POST as prefsPost } from "@/app/api/agent/prefs/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { POST as nudgePost } from "@/app/api/chat/nudge/route";
import {
  ACTIVITY_CAP,
  WAITING_EXPIRES_MS,
  expireStale,
  normalizeActivity,
  transitionActivity,
  upsertActivity,
} from "@/lib/agent-activity";
import { activitySentence, groupActivity, type ActivityEntry } from "@/lib/agent-activity-text";
import { nextNudge } from "@/lib/nudge";
import { proposeAction } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";
import { cancelOrder, listOrders, readActivityView } from "@/lib/store-meta";

const SUB = "auth0|shopper";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-21T08:00:00.000Z");
const CONSENT_AT = "2026-11-01T00:00:00.000Z";

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

function post(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

function activity(): ActivityEntry[] {
  return normalizeActivity(db.meta.agent_activity);
}

type ConfirmBody = {
  error?: string;
  order: { id: string; undoUntil: string };
  overCap: { actionId: string };
};

async function confirmJson(actionId: string) {
  const res = await confirm(post("/api/chat/confirm", { actionId }));
  return { status: res.status, body: (await res.json()) as ConfirmBody };
}

async function pendingOrder(opts?: Parameters<typeof proposeAction>[2]) {
  const pending = await proposeAction(SUB, { op: "place_order" }, opts);
  if (!("actionId" in pending)) throw new Error(`expected pending, got ${JSON.stringify(pending)}`);
  return pending.actionId;
}

function setUp(prefs: Record<string, unknown> | null = { consentAt: CONSENT_AT, capCents: 6000 }, productId = "ethiopia-250") {
  db.meta = { cart: { items: [{ productId, qty: 1 }], coupon: null }, ...(prefs ? { agent_prefs: prefs } : {}) };
}

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "act_1",
    ts: NOW.toISOString(),
    agent: "barista",
    action: "place_order",
    subject: "Ethiopia Yirgacheffe 250g",
    reason: "You asked Barista in chat.",
    amountCents: 1944,
    orderId: null,
    consent: CONSENT_AT,
    status: "done",
    ...over,
  };
}

beforeEach(() => {
  nonces.ids.clear();
  db.meta = {};
  process.env.APPROVAL_SECRET = "action-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  delete process.env.DATABASE_URL;
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "a@example.com", name: "Ada" });
});

afterEach(() => {
  delete process.env.APPROVAL_SECRET;
  delete process.env.APP_BASE_URL;
});

describe("audit trail for a Barista order", () => {
  it("writes a waiting entry when the action is proposed", async () => {
    setUp();
    await pendingOrder();
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({
      agent: "barista",
      action: "place_order",
      subject: "Ethiopia Yirgacheffe 250g",
      reason: "You asked Barista in chat.",
      amountCents: 1944,
      orderId: null,
      consent: CONSENT_AT,
      status: "waiting",
    });
  });

  it("moves the same entry to done on confirm, with the order id and amount, and tags the order as Barista's", async () => {
    setUp();
    const { status, body } = await confirmJson(await pendingOrder({ reason: "Your Ethiopia bag is about due." }));
    expect(status).toBe(200);
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({
      status: "done",
      orderId: body.order.id,
      amountCents: 1944,
      reason: "Your Ethiopia bag is about due.",
      consent: CONSENT_AT,
    });
    const orders = await listOrders(SUB);
    expect(orders[0]).toMatchObject({ id: body.order.id, placedBy: "barista" });
  });

  it("an order placed outside Barista's flow has no placedBy tag", async () => {
    setUp();
    const { placeOrder } = await import("@/lib/store-meta");
    const placed = await placeOrder(SUB);
    expect("error" in placed).toBe(false);
    expect((await listOrders(SUB))[0]?.placedBy).toBeUndefined();
  });

  it("keeps the entry waiting when consent is missing, and nothing is ordered", async () => {
    setUp(null);
    const { status, body } = await confirmJson(await pendingOrder());
    expect(status).toBe(403);
    expect(body.error).toBe("consent_required");
    expect(activity().map((row) => row.status)).toEqual(["waiting"]);
    expect(activity()[0]?.consent).toBeNull();
    expect(await listOrders(SUB)).toHaveLength(0);
  });

  it("records an over-cap order as one entry that stays waiting until the second OK", async () => {
    setUp({ consentAt: CONSENT_AT, capCents: 1000 });
    const first = await confirmJson(await pendingOrder({ reason: "Your Ethiopia bag is about due." }));
    expect(first.body.overCap).toBeTruthy();
    expect(activity()).toHaveLength(1);
    expect(activity()[0]?.status).toBe("waiting");
    expect(activity()[0]?.reason).toContain("Your Ethiopia bag is about due.");
    expect(activity()[0]?.reason).toContain("Over your $10.00 cap");

    const second = await confirmJson(first.body.overCap.actionId);
    expect(second.status).toBe(200);
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({ status: "done", orderId: second.body.order.id });
  });

  it("marks the entry undone when the order is cancelled inside the 10-minute window", async () => {
    setUp();
    const { body } = await confirmJson(await pendingOrder());
    const placedAt = new Date((await listOrders(SUB))[0]!.createdAt);
    const cancelled = await cancelOrder(SUB, body.order.id, new Date(placedAt.getTime() + 9 * 60 * 1000));
    expect("error" in cancelled).toBe(false);
    expect(activity()[0]?.status).toBe("undone");
  });

  it("leaves the entry done when the undo window has passed", async () => {
    setUp();
    const { body } = await confirmJson(await pendingOrder());
    const placedAt = new Date((await listOrders(SUB))[0]!.createdAt);
    const cancelled = await cancelOrder(SUB, body.order.id, new Date(placedAt.getTime() + 11 * 60 * 1000));
    expect("error" in cancelled).toBe(true);
    expect(activity()[0]?.status).toBe("done");
  });

  it("does not store chat text or product ids beyond the sentence fields", async () => {
    setUp();
    await confirmJson(await pendingOrder());
    expect(Object.keys(activity()[0]!).sort()).toEqual(
      ["action", "agent", "amountCents", "consent", "id", "orderId", "reason", "status", "subject", "ts"].sort(),
    );
  });
});

describe("audit trail for the Barista suggestion and consent", () => {
  const orders = [
    {
      id: "BB-OLD1",
      createdAt: new Date(NOW.getTime() - 24 * DAY).toISOString(),
      cancelledAt: null,
      subtotalCents: 1800,
      discountCents: 0,
      taxCents: 144,
      totalCents: 1944,
      coupon: null,
      items: [{ productId: "ethiopia-250", name: "Ethiopia Yirgacheffe 250g", unitPriceCents: 1800, qty: 1 }],
    },
  ];

  it("writes a waiting 'suggest' entry with the reason when the nudge is shown", async () => {
    db.meta = { orders, agent_prefs: { consentAt: CONSENT_AT, capCents: 6000 } };
    const shown = await nextNudge(SUB, "nudge_abc123", NOW);
    expect(shown.nudge).toBeTruthy();
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({ action: "suggest", status: "waiting", subject: "Ethiopia Yirgacheffe 250g" });
    expect(activity()[0]?.reason).toContain("assuming ~15 g/day");
  });

  it("marks the suggestion done when accepted, and the add_many entry carries the same reason", async () => {
    db.meta = { orders, agent_prefs: { consentAt: CONSENT_AT, capCents: 6000 } };
    await nextNudge(SUB, "nudge_abc123", NOW);
    const res = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "reorder" }));
    expect(res.status).toBe(200);
    const rows = activity();
    expect(rows.find((row) => row.action === "suggest")?.status).toBe("done");
    const added = rows.find((row) => row.action === "add_many");
    expect(added).toMatchObject({ status: "waiting" });
    expect(added?.reason).toBe(rows.find((row) => row.action === "suggest")?.reason);
  });

  it("marks the suggestion declined when snoozed", async () => {
    db.meta = { orders, agent_prefs: { consentAt: CONSENT_AT, capCents: 6000 } };
    await nextNudge(SUB, "nudge_abc123", NOW);
    const res = await nudgePost(post("/api/chat/nudge", { action: "snooze" }));
    expect(res.status).toBe(200);
    expect(activity().find((row) => row.action === "suggest")?.status).toBe("declined");
  });

  it("records consent and later cap changes, but not a cap saved before any consent", async () => {
    await prefsPost(post("/api/agent/prefs", { capCents: 3000 }));
    expect(activity()).toHaveLength(0);

    await prefsPost(post("/api/agent/prefs", { capCents: 10000, consent: true }));
    expect(activity()).toHaveLength(1);
    expect(activity()[0]).toMatchObject({ action: "consent", status: "done", amountCents: 10000 });
    expect(activity()[0]?.consent).toBe((db.meta.agent_prefs as { consentAt: string }).consentAt);
    expect(activity()[0]?.reason).toContain("allowed Barista");

    await prefsPost(post("/api/agent/prefs", { capCents: 3000 }));
    expect(activity()).toHaveLength(2);
    expect(activity()[0]?.reason).toContain("changed");
  });
});

describe("activity API", () => {
  it("requires a signed-in shopper", async () => {
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await activityGet()).status).toBe(401);
  });

  it("returns the trail newest first, with an undo deadline only while the order can be undone", async () => {
    setUp();
    const { body } = await confirmJson(await pendingOrder());
    const res = await activityGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const view = (await res.json()) as { entries: Array<ActivityEntry & { undoUntil: string | null }> };
    expect(view.entries[0]).toMatchObject({ orderId: body.order.id, status: "done" });
    expect(view.entries[0]?.undoUntil).toBe(body.order.undoUntil);

    const later = await readActivityView(SUB, new Date(Date.now() + 11 * 60 * 1000));
    expect(later.entries[0]?.undoUntil).toBeNull();
  });
});

describe("activity helpers", () => {
  it("keeps the newest ACTIVITY_CAP entries", () => {
    let rows: ActivityEntry[] = [];
    for (let i = 0; i < ACTIVITY_CAP + 5; i++) {
      rows = upsertActivity(rows, entry({ id: `act_${i}`, ts: new Date(NOW.getTime() + i * 1000).toISOString() }));
    }
    expect(rows).toHaveLength(ACTIVITY_CAP);
    expect(rows.some((row) => row.id === "act_0")).toBe(false);
    expect(rows.some((row) => row.id === `act_${ACTIVITY_CAP + 4}`)).toBe(true);
  });

  it("transitions only the named entry and ignores an unknown id", () => {
    const rows = [entry({ id: "a", status: "waiting" }), entry({ id: "b", status: "waiting" })];
    const next = transitionActivity(rows, "a", { status: "done" }, NOW);
    expect(next?.map((row) => row.status)).toEqual(["done", "waiting"]);
    expect(transitionActivity(rows, "zzz", { status: "done" }, NOW)).toBeNull();
  });

  it("drops malformed stored entries", () => {
    expect(normalizeActivity("nope")).toEqual([]);
    expect(normalizeActivity([{ id: 1 }, null, entry()])).toHaveLength(1);
  });

  it("shows a waiting entry as declined once its signed confirmation has expired", () => {
    const old = entry({ status: "waiting", ts: new Date(NOW.getTime() - WAITING_EXPIRES_MS - 1000).toISOString() });
    const fresh = entry({ id: "b", status: "waiting", ts: new Date(NOW.getTime() - 60 * 1000).toISOString() });
    expect(expireStale([old, fresh], NOW).map((row) => row.status)).toEqual(["declined", "waiting"]);
  });

  it("words each status the way the mockup does", () => {
    expect(activitySentence(entry())).toBe("Barista ordered Ethiopia Yirgacheffe 250g, S$19.44");
    expect(activitySentence(entry({ status: "undone" }))).toBe("Barista ordered Ethiopia Yirgacheffe 250g, S$19.44. You undid it.");
    expect(activitySentence(entry({ status: "waiting" }))).toBe("Barista has an order ready for you to confirm, S$19.44");
    expect(activitySentence(entry({ action: "consent", amountCents: 6000 }))).toBe("You allowed Barista to order up to S$60 per order");
  });

  it("groups into Today, This week and Earlier, newest first", () => {
    const rows = [
      entry({ id: "old", ts: new Date(NOW.getTime() - 20 * DAY).toISOString() }),
      entry({ id: "week", ts: new Date(NOW.getTime() - 3 * DAY).toISOString() }),
      entry({ id: "t2", ts: new Date(NOW.getTime() - 1000).toISOString() }),
      entry({ id: "t1", ts: NOW.toISOString() }),
    ];
    const groups = groupActivity(rows, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Today", "This week", "Earlier"]);
    expect(groups[0]?.entries.map((row) => row.id)).toEqual(["t1", "t2"]);
  });
});
