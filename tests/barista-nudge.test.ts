import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as nudgeGet, POST as nudgePost } from "@/app/api/chat/nudge/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { SNOOZE_DAYS, snoozeNudges } from "@/lib/agent-prefs";
import { buildNudge, nextNudge, nudgeGate } from "@/lib/nudge";
import { commitAction, proposeAction } from "@/lib/pending-action";
import { cancelOrder, readNudgeInputs } from "@/lib/store-meta";
import { UNDO_WINDOW_MS } from "@/lib/order-status";
import { getShopper } from "@/lib/shopper";

const SUB = "auth0|shopper";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-21T08:00:00.000Z");

const nonces = vi.hoisted(() => ({ ids: new Set<string>() }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, patches: [] as Record<string, unknown>[] }));

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
    db.patches.push(structuredClone(patch));
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

function order(id: string, createdAt: Date, productId = "ethiopia-250", qty = 1) {
  return {
    id,
    createdAt: createdAt.toISOString(),
    cancelledAt: null,
    subtotalCents: 1800 * qty,
    discountCents: 0,
    taxCents: 144 * qty,
    totalCents: 1944 * qty,
    coupon: null,
    items: [{ productId, name: "Ethiopia Yirgacheffe 250g", unitPriceCents: 1800, qty }],
  };
}

const CONSENTED = { consentAt: "2026-11-01T00:00:00.000Z", capCents: 6000 };

function dueOrders(now = NOW) {
  return [order("BB-OLD1", new Date(now.getTime() - 24 * DAY))];
}

function post(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

function nudgeUrl(session: string) {
  return new Request(`http://localhost/api/chat/nudge?session=${session}`);
}

beforeEach(() => {
  nonces.ids.clear();
  db.meta = {};
  db.patches = [];
  process.env.APPROVAL_SECRET = "action-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  delete process.env.DATABASE_URL;
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "a@example.com", name: "Ada" });
});

afterEach(() => {
  delete process.env.APPROVAL_SECRET;
  delete process.env.APP_BASE_URL;
});

describe("buildNudge", () => {
  it("builds a reorder card and a new-bean card, each with its reason and the g/day assumption", async () => {
    db.meta = { orders: dueOrders() };
    const result = buildNudge(await readNudgeInputs(SUB), [], NOW);
    if (!result.nudge) throw new Error(`expected a nudge, got ${result.skip}`);
    const { reorder, newBean } = result.nudge;
    expect(reorder.lines).toEqual([{ productId: "ethiopia-250", qty: 1 }]);
    expect(reorder.reason).toContain("assuming ~15 g/day");
    expect(result.nudge.gramsPerDay).toBe(15);
    expect(reorder.priceCents).toBe(1800);
    expect(newBean?.lines).toEqual([{ productId: "kenya-ichangi-200", qty: 1 }]);
    expect(newBean?.reason).toContain("similar to Ethiopia Yirgacheffe 250g");
  });

  it("uses recommend.added history to rank the new bean", async () => {
    db.meta = { orders: dueOrders() };
    const result = buildNudge(await readNudgeInputs(SUB), ["india-monsooned-malabar-250", "india-monsooned-malabar-250"], NOW);
    expect(result.nudge?.newBean?.lines[0]?.productId).toBe("india-monsooned-malabar-250");
    expect(result.nudge?.newBean?.reason).toContain("added it from a recommendation 2 times");
  });

  it("shows nothing before the shopper is due or without a bean order", async () => {
    db.meta = { orders: [order("BB-NEW1", new Date(NOW.getTime() - 2 * DAY))] };
    expect(buildNudge(await readNudgeInputs(SUB), [], NOW)).toEqual({ nudge: null, skip: "not_due" });
    db.meta = { orders: [] };
    expect(buildNudge(await readNudgeInputs(SUB), [], NOW)).toEqual({ nudge: null, skip: "no_history" });
  });

  it("labels the data for test and demo shoppers only", async () => {
    db.meta = { orders: dueOrders() };
    expect(buildNudge(await readNudgeInputs(SUB), [], NOW).nudge?.demo).toBe(false);
    db.meta = { orders: dueOrders(), is_test: true };
    expect(buildNudge(await readNudgeInputs(SUB), [], NOW).nudge?.demo).toBe(true);
  });
});

describe("nudge gates", () => {
  const base = { capCents: 6000, askEveryOrder: true as const };

  it("paused, snoozed, and same-session each suppress the nudge", () => {
    expect(nudgeGate({ ...base, paused: true }, "s1", NOW)).toBe("paused");
    expect(nudgeGate({ ...base, snoozeUntil: new Date(NOW.getTime() + DAY).toISOString() }, "s1", NOW)).toBe("snoozed");
    expect(nudgeGate({ ...base, lastNudgeSession: "s1" }, "s1", NOW)).toBe("already_shown");
    expect(nudgeGate({ ...base, lastNudgeSession: "s1" }, "s2", NOW)).toBeNull();
    expect(nudgeGate(base, null, NOW)).toBeNull();
  });

  it("an expired snooze no longer suppresses", () => {
    expect(nudgeGate({ ...base, snoozeUntil: new Date(NOW.getTime() - 1).toISOString() }, "s1", NOW)).toBeNull();
  });
});

describe("one nudge per session", () => {
  it("returns the nudge once, records lastNudgeSession, then nothing for the same session", async () => {
    db.meta = { orders: dueOrders() };
    const first = await nextNudge(SUB, "nudge_session-A", NOW);
    expect(first.nudge).not.toBeNull();
    expect((db.meta.agent_prefs as Record<string, unknown>).lastNudgeSession).toBe("nudge_session-A");
    expect(await nextNudge(SUB, "nudge_session-A", NOW)).toEqual({ nudge: null, skip: "already_shown" });
    expect((await nextNudge(SUB, "nudge_session-B", NOW)).nudge).not.toBeNull();
  });

  it("GET /api/chat/nudge serves one nudge for a session, and 401s a guest", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))] };
    const first = await nudgeGet(nudgeUrl("nudge_route-1"));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { nudge: unknown }).nudge).not.toBeNull();
    const again = await nudgeGet(nudgeUrl("nudge_route-1"));
    expect(((await again.json()) as { nudge: unknown }).nudge).toBeNull();

    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await nudgeGet(nudgeUrl("nudge_route-2"))).status).toBe(401);
  });

  it("ignores a session id that is not safe to store", async () => {
    db.meta = { orders: dueOrders() };
    await nextNudge(SUB, "bad session!", NOW);
    expect(db.meta.agent_prefs).toBeUndefined();
  });
});

describe("snooze", () => {
  it("'Not now' snoozes for exactly seven days, then the nudge returns", async () => {
    db.meta = { orders: dueOrders() };
    const until = await snoozeNudges(SUB, NOW);
    expect(SNOOZE_DAYS).toBe(7);
    expect(until).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    expect((db.meta.agent_prefs as Record<string, unknown>).snoozeUntil).toBe(until);
    expect(await nextNudge(SUB, "nudge_s", new Date(NOW.getTime() + 7 * DAY - 1))).toEqual({ nudge: null, skip: "snoozed" });
    expect((await nextNudge(SUB, "nudge_s", new Date(NOW.getTime() + 7 * DAY))).nudge).not.toBeNull();
  });

  it("POST snooze writes agent_prefs.snoozeUntil and keeps other prefs", async () => {
    db.meta = { agent_prefs: { capCents: 10000, consentAt: "2026-11-01T00:00:00.000Z" } };
    const res = await nudgePost(post("/api/chat/nudge", { action: "snooze" }));
    expect(res.status).toBe(200);
    const prefs = db.meta.agent_prefs as Record<string, unknown>;
    expect(prefs.capCents).toBe(10000);
    expect(prefs.consentAt).toBe("2026-11-01T00:00:00.000Z");
    const until = new Date(String(prefs.snoozeUntil)).getTime();
    expect(until - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(7 * DAY);
  });

  it("rejects a POST that is not a known action", async () => {
    expect((await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "all" }))).status).toBe(400);
    expect((await nudgePost(post("/api/chat/nudge", { action: "snooze", extra: 1 }))).status).toBe(400);
  });
});

describe("paused", () => {
  it("shows no nudge and refuses to sign a multi-add while paused", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))], agent_prefs: { paused: true } };
    expect(await nextNudge(SUB, "nudge_p", NOW)).toEqual({ nudge: null, skip: "paused" });
    const res = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "both" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("paused");
    expect(nonces.ids.size).toBe(0);
  });
});

describe("multi-add through the signed confirm flow", () => {
  it("'Yes, both' signs one add_many, one Confirm adds both lines and returns a signed Place order step", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))] };
    const accepted = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "both" }));
    expect(accepted.status).toBe(200);
    const pending = (await accepted.json()) as { actionId: string; summary: string };
    expect(pending.summary).toContain("Ethiopia Yirgacheffe 250g");
    expect(pending.summary).toContain("Kenya Ichangi 200g");
    expect(db.meta.cart).toBeUndefined();

    const done = await confirm(post("/api/chat/confirm", { actionId: pending.actionId }));
    expect(done.status).toBe(200);
    const body = (await done.json()) as { next?: { actionId: string; cart: { lines: { productId: string }[]; totalCents: number } } };
    expect(db.meta.cart).toMatchObject({
      items: [
        { productId: "ethiopia-250", qty: 1 },
        { productId: "kenya-ichangi-200", qty: 1 },
      ],
    });
    expect(body.next?.cart.lines.map((line) => line.productId)).toEqual(["ethiopia-250", "kenya-ichangi-200"]);
    expect(body.next?.cart.totalCents).toBe(Math.round((1800 + 2450) * 1.08));
    expect(db.patches.filter((patch) => "cart" in patch)).toHaveLength(1);

    expect((await confirm(post("/api/chat/confirm", { actionId: pending.actionId }))).status).toBe(409);
  });

  it("'Just the reorder' adds only the reorder lines", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))] };
    const accepted = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "reorder" }));
    const pending = (await accepted.json()) as { actionId: string };
    await confirm(post("/api/chat/confirm", { actionId: pending.actionId }));
    expect(db.meta.cart).toMatchObject({ items: [{ productId: "ethiopia-250", qty: 1 }] });
  });

  it("Place order then Done: confirming the signed next step places the order and returns the undo deadline", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))], agent_prefs: CONSENTED };
    const accepted = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "both" }));
    const pending = (await accepted.json()) as { actionId: string };
    const added = (await (await confirm(post("/api/chat/confirm", { actionId: pending.actionId }))).json()) as {
      next: { actionId: string };
    };
    const placed = await confirm(post("/api/chat/confirm", { actionId: added.next.actionId }));
    expect(placed.status).toBe(200);
    const body = (await placed.json()) as { order: { id: string; createdAt: string; undoUntil: string; lines: unknown[] } };
    expect(body.order.lines).toHaveLength(2);
    expect(new Date(body.order.undoUntil).getTime() - new Date(body.order.createdAt).getTime()).toBe(UNDO_WINDOW_MS);
    expect(db.meta.cart).toEqual({ items: [], coupon: null });
  });

  it("the undo window is ten minutes: cancel works at 9:59 and is refused after 10:00", async () => {
    db.meta = { orders: [order("BB-OLD1", new Date(Date.now() - 24 * DAY))], agent_prefs: CONSENTED };
    const accepted = await nudgePost(post("/api/chat/nudge", { action: "accept", choice: "reorder" }));
    const pending = (await accepted.json()) as { actionId: string };
    const added = (await (await confirm(post("/api/chat/confirm", { actionId: pending.actionId }))).json()) as {
      next: { actionId: string };
    };
    const placed = (await (await confirm(post("/api/chat/confirm", { actionId: added.next.actionId }))).json()) as {
      order: { id: string; createdAt: string };
    };
    const at = new Date(placed.order.createdAt).getTime();

    expect(await cancelOrder(SUB, placed.order.id, new Date(at + UNDO_WINDOW_MS))).toEqual({ error: "not_cancellable" });
    const undone = await cancelOrder(SUB, placed.order.id, new Date(at + UNDO_WINDOW_MS - 1000));
    expect(undone).toMatchObject({ id: placed.order.id, status: "cancelled" });
  });

  it("undo through the cancel route refuses an order that is past the window", async () => {
    db.meta = { orders: [order("BB-LATE1", new Date(Date.now() - 11 * 60 * 1000))] };
    const res = await cancelRoute(post("/api/orders/BB-LATE1/cancel", {}), { params: Promise.resolve({ id: "BB-LATE1" }) });
    expect(res.status).toBe(409);
  });

  it("rejects an empty, oversized, or unknown-product multi-add and another shopper's confirm", async () => {
    expect(await proposeAction(SUB, { op: "add_many", lines: [{ productId: "no-such-bean", qty: 1 }] })).toEqual({
      error: "unknown_product",
    });
    const lines = Array.from({ length: 6 }, () => ({ productId: "mug", qty: 1 }));
    expect(await proposeAction(SUB, { op: "add_many", lines })).toEqual({ error: "invalid_body" });
    expect(await proposeAction(SUB, { op: "add_many", lines: [] })).toEqual({ error: "invalid_body" });
    const pending = await proposeAction(SUB, { op: "add_many", lines: [{ productId: "mug", qty: 1 }] });
    if (!("actionId" in pending)) throw new Error("expected pending");
    const other = await commitAction("auth0|other", pending.actionId, { id: "auth0|other" });
    expect(other).toMatchObject({ ok: false, status: 403 });
    expect(db.meta.cart).toBeUndefined();
  });
});
