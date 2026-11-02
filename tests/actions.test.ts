import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { CART_WRITE_HOUR_LIMIT } from "@/lib/limits";
import { codeAppearsIn, commitAction, proposeAction, textAppearsIn } from "@/lib/pending-action";
import { pendingFromEvents } from "@/lib/agent-chat";
import { getShopper } from "@/lib/shopper";

const nonces = vi.hoisted(() => ({ ids: new Set<string>() }));
const lines = vi.hoisted(() => ({ text: [] as string[] }));
const filed = vi.hoisted(() => ({ calls: [] as string[] }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, pauseMs: 0, writes: 0 }));

vi.mock("@/lib/upstash", () => ({
  issueNonce: async (jti: string) => {
    nonces.ids.add(jti);
  },
  consumeNonce: async (jti: string) => {
    if (!nonces.ids.has(jti)) return false;
    nonces.ids.delete(jti);
    return true;
  },
  rearmNonce: async (jti: string) => {
    nonces.ids.add(jti);
  },
  rememberedLines: async () => lines.text.slice(),
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
    db.writes += 1;
    if (db.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, db.pauseMs));
    db.meta = { ...db.meta, ...patch };
    return structuredClone(db.meta);
  },
  mgmtConfigured: () => true,
}));

vi.mock("@/lib/shopper", () => ({
  getShopper: vi.fn(),
  reporterBlock: (shopper: { id: string; name?: string }) => `**Reported by:** ${shopper.name}\n**Auth0 user id:** \`${shopper.id}\``,
}));

vi.mock("@/lib/rate-limit", () => ({
  tooManyFeedbackReports: async () => false,
}));

vi.mock("@/lib/file-feedback", () => ({
  fileFeedback: async (feedback: string) => {
    filed.calls.push(feedback);
  },
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (task: () => Promise<void>) => {
      void task();
    },
  };
});

const shopper = { id: "auth0|shopper", email: "ada@example.com", name: "Ada" };

function confirmRequest(actionId: string) {
  return new Request("http://localhost/api/chat/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ actionId }),
  });
}

describe("confirm actions", () => {
  beforeEach(() => {
    nonces.ids.clear();
    lines.text = ["please apply SAVE10"];
    filed.calls = [];
    db.meta = {};
    db.pauseMs = 0;
    db.writes = 0;
    process.env.APPROVAL_SECRET = "action-secret";
    process.env.APP_BASE_URL = "http://localhost:3000";
    vi.mocked(getShopper).mockResolvedValue(shopper);
  });

  afterEach(() => {
    delete process.env.APPROVAL_SECRET;
    delete process.env.APP_BASE_URL;
  });

  it("matches a typed code and ignores a code hidden inside another word", () => {
    expect(codeAppearsIn("SAVE10", ["please apply SAVE10"])).toBe(true);
    expect(codeAppearsIn("save10", ["please apply SAVE10"])).toBe(true);
    expect(codeAppearsIn("BEANS20", ["please apply SAVE10"])).toBe(false);
    expect(codeAppearsIn("SAVE", ["please apply SAVE10"])).toBe(false);
  });

  it("prepares an add without writing, then confirm writes the catalogue price once", async () => {
    const open = await proposeAction("auth0|shopper", { op: "add_to_cart", productId: "mug", qty: 2 });
    if (!("actionId" in open)) throw new Error("expected pending");
    const pending = open;
    expect(pending.summary).toContain("$14.00");
    expect(pending.summary).not.toContain("999");
    expect(db.meta.cart).toBeUndefined();

    const done = await confirm(confirmRequest(pending.actionId));
    expect(done.status).toBe(200);
    expect(db.meta.cart).toMatchObject({ items: [{ productId: "mug", qty: 2 }] });
    const again = await confirm(confirmRequest(pending.actionId));
    expect(again.status).toBe(409);
  });

  it("rejects a coupon the shopper did not type and applies one they did", async () => {
    const guessed = await proposeAction("auth0|shopper", { op: "apply_coupon", code: "BEANS20" });
    expect(guessed).toEqual({ error: "coupon_not_typed" });
    expect(db.meta.cart).toBeUndefined();

    const typed = await proposeAction("auth0|shopper", { op: "apply_coupon", code: "save10" });
    expect(typed).toMatchObject({ pending: true });
    if (!("actionId" in typed)) return;
    const committed = await commitAction("auth0|shopper", typed.actionId, shopper);
    expect(committed.ok).toBe(true);
    expect(db.meta.cart).toMatchObject({ coupon: "SAVE10" });
  });

  it("rejects another shopper's confirm and files a report only after confirm", async () => {
    const message = "Add to cart does nothing for the Canvas Tote Bag.";
    lines.text = [message];
    const pending = await proposeAction("auth0|shopper", {
      op: "report_problem",
      message,
    });
    if (!("actionId" in pending)) throw new Error("expected pending");
    const other = await commitAction("auth0|other", pending.actionId, { ...shopper, id: "auth0|other" });
    expect(other).toMatchObject({ ok: false, status: 403 });
    expect(filed.calls).toHaveLength(0);

    vi.mocked(getShopper).mockResolvedValue(shopper);
    const sent = await confirm(confirmRequest(pending.actionId));
    expect(sent.status).toBe(200);
    expect(filed.calls).toEqual(["Add to cart does nothing for the Canvas Tote Bag."]);
    expect(db.meta.cart).toBeUndefined();
  });

  it("uses this turn's signed summary and ignores an older action and the agent's text", async () => {
    const prepared = await proposeAction("auth0|shopper", { op: "add_to_cart", productId: "mug", qty: 1 });
    if (!("actionId" in prepared)) throw new Error("expected pending");
    const events = [
      {
        type: "action.result",
        turnId: "turn-old",
        data: { output: { pending: true, actionId: prepared.actionId, summary: "old card" } },
      },
      { type: "message.completed", turnId: "turn-old", data: { text: "old", finishReason: "stop" } },
      { type: "message.completed", turnId: "turn-new", data: { text: "Added nothing yet.", finishReason: "stop" } },
      {
        type: "action.result",
        turnId: "turn-new",
        data: { output: { pending: true, actionId: prepared.actionId, summary: "AGENT TEXT" } },
      },
    ];
    const found = pendingFromEvents(events, "auth0|shopper", "action-secret");
    expect(found?.actionId).toBe(prepared.actionId);
    expect(found?.summary).toBe(prepared.summary);
    expect(found?.summary).not.toContain("AGENT TEXT");
    expect(pendingFromEvents(events, "auth0|other", "action-secret")).toBeUndefined();
    expect(
      pendingFromEvents(
        [
          events[0]!,
          { type: "message.completed", turnId: "turn-new", data: { text: "No change.", finishReason: "stop" } },
        ],
        "auth0|shopper",
        "action-secret",
      ),
    ).toBeUndefined();
  });

  it("rejects place_order when the cart changed and keeps the confirmation", async () => {
    db.meta = { cart: { items: [{ productId: "mug", qty: 1 }], coupon: null } };
    const pending = await proposeAction("auth0|shopper", { op: "place_order" });
    if (!("actionId" in pending)) throw new Error("expected pending");
    db.meta = { cart: { items: [{ productId: "mug", qty: 2 }], coupon: null } };
    const changed = await commitAction("auth0|shopper", pending.actionId, shopper);
    expect(changed).toMatchObject({
      ok: false,
      error: "cart_changed",
      message: "Your cart changed. Ask again to place the order.",
    });
    expect(nonces.ids.size).toBe(1);
  });

  it("shows the typed report text, capped at 500 characters", async () => {
    const text = "Add to cart does nothing for the Canvas Tote Bag.";
    lines.text = [text];
    const pending = await proposeAction("auth0|shopper", { op: "report_problem", message: text });
    expect(pending).toMatchObject({ pending: true, summary: `Send report: ${text}` });
    expect(textAppearsIn("Tote Bag", lines.text)).toBe(false);
    expect(textAppearsIn("add to cart does nothing for the canvas tote bag.", ["Add to cart", "does nothing for the Canvas Tote Bag."])).toBe(true);
    const invented = await proposeAction("auth0|shopper", {
      op: "report_problem",
      message: "The warehouse is closed on Sundays.",
    });
    expect(invented).toEqual({ error: "report_not_typed" });
    const long = `${"a".repeat(500)} extra that was not typed`;
    lines.text = ["a".repeat(500)];
    const capped = await proposeAction("auth0|shopper", { op: "report_problem", message: long });
    expect(capped).toMatchObject({ pending: true, summary: `Send report: ${"a".repeat(500)}` });
  });

  it("lets one of two parallel confirms write and rejects the other", async () => {
    const pending = await proposeAction("auth0|shopper", { op: "add_to_cart", productId: "mug", qty: 1 });
    if (!("actionId" in pending)) throw new Error("expected pending");
    db.writes = 0;
    db.pauseMs = 40;
    const [first, second] = await Promise.all([
      commitAction("auth0|shopper", pending.actionId, shopper),
      commitAction("auth0|shopper", pending.actionId, shopper),
    ]);
    db.pauseMs = 0;
    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: "already_used" }),
    ]);
    expect(db.writes).toBe(1);
  });

  it("puts the confirmation back when the write fails", async () => {
    db.meta = {
      chat_limits: {
        messages: [],
        cartWrites: Array.from({ length: CART_WRITE_HOUR_LIMIT }, () => Date.now()),
        orderWrites: [],
      },
    };
    const pending = await proposeAction("auth0|shopper", { op: "add_to_cart", productId: "mug", qty: 1 });
    if (!("actionId" in pending)) throw new Error("expected pending");
    const blocked = await commitAction("auth0|shopper", pending.actionId, shopper);
    expect(blocked).toMatchObject({ ok: false, error: "rate_limited" });
    expect(nonces.ids.size).toBe(1);
  });
});
