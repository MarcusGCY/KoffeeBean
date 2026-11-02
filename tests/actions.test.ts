import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as prepare } from "@/app/api/agent/actions/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { signSupportToken } from "@/lib/support-token";
import { codeAppearsIn, commitAction, proposeAction } from "@/lib/pending-action";
import { pendingFromEvents } from "@/lib/agent-chat";
import { getShopper } from "@/lib/shopper";

const nonces = vi.hoisted(() => ({ ids: new Set<string>() }));
const lines = vi.hoisted(() => ({ text: [] as string[] }));
const filed = vi.hoisted(() => ({ calls: [] as string[] }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("@/lib/upstash", () => ({
  issueNonce: async (jti: string) => {
    nonces.ids.add(jti);
  },
  consumeNonce: async (jti: string) => {
    if (!nonces.ids.has(jti)) return false;
    nonces.ids.delete(jti);
    return true;
  },
  rememberedLines: async () => lines.text.slice(),
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async () => structuredClone(db.meta),
  patchAppMetadata: async (_userId: string, patch: Record<string, unknown>) => {
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

function agentRequest(body: unknown, userId = "auth0|shopper") {
  return new Request("http://localhost/api/agent/actions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${signSupportToken(userId, "action-secret")}`,
    },
    body: JSON.stringify(body),
  });
}

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
    process.env.SUPPORT_AGENT_SECRET = "action-secret";
    process.env.APP_BASE_URL = "http://localhost:3000";
    vi.mocked(getShopper).mockResolvedValue(shopper);
  });

  afterEach(() => {
    delete process.env.SUPPORT_AGENT_SECRET;
    delete process.env.APP_BASE_URL;
  });

  it("matches a typed code and ignores a code hidden inside another word", () => {
    expect(codeAppearsIn("SAVE10", ["please apply SAVE10"])).toBe(true);
    expect(codeAppearsIn("save10", ["please apply SAVE10"])).toBe(true);
    expect(codeAppearsIn("BEANS20", ["please apply SAVE10"])).toBe(false);
    expect(codeAppearsIn("SAVE", ["please apply SAVE10"])).toBe(false);
  });

  it("prepares an add without writing, then confirm writes the catalogue price once", async () => {
    const prepared = await prepare(agentRequest({ op: "add_to_cart", productId: "mug", qty: 2, userId: "auth0|other" }));
    expect(prepared.status).toBe(400);

    const open = await prepare(agentRequest({ op: "add_to_cart", productId: "mug", qty: 2 }));
    expect(open.status).toBe(200);
    const pending = (await open.json()) as { actionId: string; summary: string };
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
    const pending = await proposeAction("auth0|shopper", {
      op: "report_problem",
      message: "Add to cart does nothing for the Canvas Tote Bag.",
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

  it("reads a pending action from the agent tool result", () => {
    const found = pendingFromEvents([
      { type: "action.result", data: { output: { pending: true, actionId: "a.b", summary: "Add 1 mug" } } },
    ]);
    expect(found).toEqual({ actionId: "a.b", summary: "Add 1 mug" });
  });
});
