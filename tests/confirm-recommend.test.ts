import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as chat } from "@/app/api/chat/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { biPayloadSchemas } from "@/lib/bi-events";
import { rememberShownRecommendation, takeAttributedSkus } from "@/lib/bi-track";
import { takeSseEvents } from "@/lib/chat-response";
import { runChatTool, proposeReorder } from "@/lib/chat-tools";
import { CART_WRITE_HOUR_LIMIT } from "@/lib/limits";
import { commitAction, proposeAction, signActionToken, verifyAction } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";

const SHOPPER = "auth0|shopper";
const OTHER = "auth0|other";
const SESSION = "chat_session_1";
const SERVER_REC = "rec_serverschown";
const MODEL_REC = "rec_modelinjected";

const redis = vi.hoisted(() => ({ kv: new Map<string, string>() }));
const bags = vi.hoisted(() => ({
  meta: new Map<string, Record<string, unknown>>(),
  lines: [] as string[],
}));
const recorded = vi.hoisted(() => ({
  events: [] as { type: string; shopperSub: string; sessionId: string | null; payload: Record<string, unknown> }[],
  fail: false,
}));
const jobs = vi.hoisted(() => ({ list: [] as Promise<unknown>[] }));

vi.mock("@/lib/shopper", () => ({
  getShopper: vi.fn(),
  reporterBlock: (shopper: { id: string }) => shopper.id,
}));

vi.mock("@/lib/demo-session", () => ({ readAdmin: async () => null }));

vi.mock("@/lib/upstash", () => ({
  takeChatSlot: async () => ({ ok: true }),
  rememberUserLines: async (_userId: string, lines: string[]) => {
    bags.lines.push(...lines);
  },
  rememberedLines: async () => bags.lines.slice(),
  issueNonce: async (jti: string) => {
    const key = `kb:act:${jti}`;
    if (redis.kv.has(key)) throw new Error("nonce");
    redis.kv.set(key, "1");
  },
  consumeNonce: async (jti: string) => {
    const key = `kb:act:${jti}`;
    const ok = redis.kv.get(key) === "1";
    redis.kv.delete(key);
    return ok;
  },
  rearmNonce: async (jti: string) => {
    redis.kv.set(`kb:act:${jti}`, "1");
  },
  redisPipeline: async (commands: (string | number)[][]) =>
    commands.map((command) => {
      const op = String(command[0]);
      if (op === "SET") {
        const key = String(command[1]);
        if (command.some((part) => String(part) === "NX") && redis.kv.has(key)) return null;
        redis.kv.set(key, String(command[2]));
        return "OK";
      }
      if (op === "GET") return redis.kv.get(String(command[1])) ?? null;
      if (op === "GETDEL") {
        const key = String(command[1]);
        const value = redis.kv.get(key) ?? null;
        redis.kv.delete(key);
        return value;
      }
      if (op === "DEL") {
        let removed = 0;
        for (const key of command.slice(1)) if (redis.kv.delete(String(key))) removed += 1;
        return removed;
      }
      if (op === "MGET") return command.slice(1).map((key) => redis.kv.get(String(key)) ?? null);
      return null;
    }),
}));

vi.mock("@/lib/auth0-mgmt", () => ({
  getAppMetadata: async (userId: string) => structuredClone(bags.meta.get(userId) ?? {}),
  patchAppMetadata: async (userId: string, patch: Record<string, unknown>) => {
    const next = { ...(bags.meta.get(userId) ?? {}), ...patch };
    bags.meta.set(userId, next);
    return structuredClone(next);
  },
  mgmtConfigured: () => true,
}));

vi.mock("@/lib/bi-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bi-events")>();
  return {
    ...actual,
    recordBiEvent: async (input: {
      type: string;
      shopperSub: string;
      sessionId?: string | null;
      payload: Record<string, unknown>;
    }) => {
      if (recorded.fail) throw new Error("neon down");
      recorded.events.push({
        type: input.type,
        shopperSub: input.shopperSub,
        sessionId: input.sessionId ?? null,
        payload: input.payload,
      });
      return { ok: true };
    },
  };
});

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (task: () => Promise<unknown>) => {
      jobs.list.push(Promise.resolve().then(task));
    },
  };
});

const shopper = { id: SHOPPER, email: "ada@example.com", name: "Ada" };

function added() {
  return recorded.events.filter((event) => event.type === "recommend.added");
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    const batch = jobs.list.splice(0);
    if (batch.length === 0) return;
    await Promise.all(batch);
  }
}

function confirmRequest(actionId: string) {
  return new Request("http://localhost/api/chat/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ actionId }),
  });
}

function xaiTools(calls: { id: string; name: string; arguments: string }[]) {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
      },
    ],
  });
}

function eventsOf(raw: string) {
  const parsed = takeSseEvents(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
  return parsed.events.map((event) => ({
    event: event.event,
    data: JSON.parse(event.data) as Record<string, unknown>,
  }));
}

describe("confirm recommendation attribution", () => {
  beforeEach(() => {
    redis.kv.clear();
    bags.meta.clear();
    bags.lines = [];
    recorded.events = [];
    recorded.fail = false;
    jobs.list = [];
    process.env.APPROVAL_SECRET = "action-secret";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.XAI_API_KEY = "xai-test-key";
    vi.mocked(getShopper).mockResolvedValue(shopper);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.APPROVAL_SECRET;
    delete process.env.APP_BASE_URL;
    delete process.env.XAI_API_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("emits recommend.added once when Confirm accepts a shown product", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return xaiTools([{ id: "call_search", name: "search_products", arguments: JSON.stringify({ query: "Something fruity" }) }]);
        }
        if (n === 2) {
          return xaiTools([
            {
              id: "call_add",
              name: "propose_cart_change",
              arguments: JSON.stringify({
                op: "add",
                productId: "ethiopia-250",
                qty: 2,
                recommendationId: MODEL_REC,
                userId: OTHER,
              }),
            },
          ]);
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: "A floral bag is a good fit." } }] });
      }),
    );

    const res = await chat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Something fruity, please add it" }],
          sessionId: "chat_live_1",
        }),
      }),
    );
    const events = eventsOf(await res.text());
    const shownId = events.find((event) => event.event === "products")?.data.recommendationId;
    const card = events.find((event) => event.event === "confirm");
    expect(typeof shownId).toBe("string");
    expect(String(shownId)).toMatch(/^rec_[0-9a-f]{12}$/);
    const claims = verifyAction(String(card?.data.actionId), "action-secret");
    expect(claims?.sub).toBe(SHOPPER);
    expect(claims?.sessionId).toBe("chat_live_1");
    expect(claims?.action).toEqual({
      op: "add_to_cart",
      productId: "ethiopia-250",
      qty: 2,
      recommendationId: shownId,
    });
    expect(JSON.stringify(claims)).not.toContain(MODEL_REC);
    expect(bags.meta.get(SHOPPER)?.cart).toBeUndefined();
    await flush();
    expect(added()).toHaveLength(0);

    const done = await confirm(confirmRequest(String(card?.data.actionId)));
    expect(done.status).toBe(200);
    await flush();
    expect(bags.meta.get(SHOPPER)?.cart).toMatchObject({ items: [{ productId: "ethiopia-250", qty: 2 }] });
    expect(added()).toHaveLength(1);
    const payload = added()[0]?.payload;
    expect(biPayloadSchemas["recommend.added"].parse(payload)).toEqual({
      recommendationId: shownId,
      productId: "ethiopia-250",
      qty: 2,
    });
    expect(added()[0]).toMatchObject({ shopperSub: SHOPPER, sessionId: "chat_live_1" });
    expect(JSON.stringify(payload)).not.toContain("ada@example.com");
    expect(JSON.stringify(payload)).not.toContain(SHOPPER);
    const shown = recorded.events.find((event) => event.type === "recommend.shown");
    expect(shown).toMatchObject({
      sessionId: "chat_live_1",
      payload: { recommendationId: shownId, productIds: expect.arrayContaining(["ethiopia-250"]) },
    });

    const again = await confirm(confirmRequest(String(card?.data.actionId)));
    expect(again.status).toBe(409);
    await flush();
    expect(added()).toHaveLength(1);
    expect(await takeAttributedSkus(SHOPPER, ["ethiopia-250", "mug"])).toEqual(["ethiopia-250"]);
  });

  it("ignores a model id, another shopper's shown product, and another session", async () => {
    const sink = { status: vi.fn(), products: vi.fn(), confirm: vi.fn(), order: vi.fn() };

    await runChatTool(
      SHOPPER,
      "propose_cart_change",
      { op: "add", productId: "mug", qty: 1, recommendationId: MODEL_REC, userId: OTHER },
      sink,
      SESSION,
    );
    const unverified = verifyAction(String(sink.confirm.mock.calls[0]?.[0].actionId), "action-secret");
    expect(unverified?.action).toEqual({ op: "add_to_cart", productId: "mug", qty: 1 });
    expect(unverified?.sessionId).toBeUndefined();

    await rememberShownRecommendation(OTHER, SESSION, SERVER_REC, ["mug"]);
    await rememberShownRecommendation(SHOPPER, "chat_other_session", SERVER_REC, ["mug"]);
    sink.confirm.mockClear();
    await runChatTool(
      SHOPPER,
      "propose_cart_change",
      { op: "add", productId: "mug", qty: 1, recommendationId: SERVER_REC },
      sink,
      SESSION,
    );
    const foreign = verifyAction(String(sink.confirm.mock.calls[0]?.[0].actionId), "action-secret");
    expect(foreign?.action).toEqual({ op: "add_to_cart", productId: "mug", qty: 1 });

    await rememberShownRecommendation(SHOPPER, SESSION, SERVER_REC, ["mug"]);
    const forwarded = await proposeAction(
      SHOPPER,
      { op: "add_to_cart", productId: "tote", qty: 1, recommendationId: SERVER_REC },
      { sessionId: SESSION },
    );
    if (!("actionId" in forwarded)) throw new Error("expected pending");
    expect(verifyAction(forwarded.actionId, "action-secret")?.action).toEqual({
      op: "add_to_cart",
      productId: "tote",
      qty: 1,
    });

    const matched = await proposeAction(
      SHOPPER,
      { op: "add_to_cart", productId: "mug", qty: 1, recommendationId: MODEL_REC },
      { sessionId: SESSION },
    );
    if (!("actionId" in matched)) throw new Error("expected pending");
    expect(verifyAction(matched.actionId, "action-secret")?.action).toEqual({
      op: "add_to_cart",
      productId: "mug",
      qty: 1,
      recommendationId: SERVER_REC,
    });
    expect(added()).toHaveLength(0);
  });

  it("emits nothing for a rejected, expired, replayed, or failed confirm", async () => {
    await rememberShownRecommendation(SHOPPER, SESSION, SERVER_REC, ["mug"]);
    const pending = await proposeAction(
      SHOPPER,
      { op: "add_to_cart", productId: "mug", qty: 1, recommendationId: MODEL_REC },
      { sessionId: SESSION },
    );
    if (!("actionId" in pending)) throw new Error("expected pending");
    expect(added()).toHaveLength(0);

    const other = await commitAction(OTHER, pending.actionId, { ...shopper, id: OTHER });
    expect(other).toMatchObject({ ok: false, status: 403 });
    await flush();
    expect(added()).toHaveLength(0);

    const expired = signActionToken(
      {
        typ: "action",
        sub: SHOPPER,
        exp: Math.floor(Date.now() / 1000) - 5,
        jti: "expired-jti",
        summary: "Add 1 mug",
        action: { op: "add_to_cart", productId: "mug", qty: 1, recommendationId: SERVER_REC },
        sessionId: SESSION,
      },
      "action-secret",
    );
    const stale = await commitAction(SHOPPER, expired, shopper);
    expect(stale.ok).toBe(false);
    await flush();
    expect(added()).toHaveLength(0);
    expect(bags.meta.get(SHOPPER)?.cart).toBeUndefined();

    bags.meta.set(SHOPPER, {
      chat_limits: {
        messages: [],
        cartWrites: Array.from({ length: CART_WRITE_HOUR_LIMIT }, () => Date.now()),
        orderWrites: [],
      },
    });
    const blocked = await commitAction(SHOPPER, pending.actionId, shopper);
    expect(blocked).toMatchObject({ ok: false, error: "rate_limited" });
    await flush();
    expect(added()).toHaveLength(0);
    expect(bags.meta.get(SHOPPER)?.cart).toBeUndefined();

    bags.meta.set(SHOPPER, {});
    const done = await confirm(confirmRequest(pending.actionId));
    expect(done.status).toBe(200);
    await flush();
    expect(added()).toHaveLength(1);

    const replay = await confirm(confirmRequest(pending.actionId));
    expect(replay.status).toBe(409);
    await flush();
    expect(added()).toHaveLength(1);
  });

  it("does not emit for coupons, quantity updates, or reorders", async () => {
    await rememberShownRecommendation(SHOPPER, SESSION, SERVER_REC, ["ethiopia-250", "mug"]);
    bags.lines = ["please apply SAVE10"];
    const coupon = await proposeAction(SHOPPER, { op: "apply_coupon", code: "save10" }, { sessionId: SESSION });
    if (!("actionId" in coupon)) throw new Error("expected coupon");
    expect((await commitAction(SHOPPER, coupon.actionId, shopper)).ok).toBe(true);
    expect(bags.meta.get(SHOPPER)?.cart).toMatchObject({ coupon: "SAVE10" });

    const qty = await proposeAction(
      SHOPPER,
      { op: "update_cart_qty", productId: "mug", qty: 1 },
      { sessionId: SESSION },
    );
    if (!("actionId" in qty)) throw new Error("expected qty");
    expect(verifyAction(qty.actionId, "action-secret")?.action).toEqual({
      op: "update_cart_qty",
      productId: "mug",
      qty: 1,
    });
    expect((await commitAction(SHOPPER, qty.actionId, shopper)).ok).toBe(true);

    bags.meta.set(SHOPPER, {
      orders: [
        {
          id: "BB-1",
          createdAt: "2026-11-01T00:00:00.000Z",
          cancelledAt: null,
          subtotalCents: 1800,
          discountCents: 0,
          taxCents: 144,
          totalCents: 1944,
          coupon: null,
          items: [{ productId: "ethiopia-250", name: "Ethiopia Yirgacheffe 250g", unitPriceCents: 1800, qty: 1 }],
        },
      ],
    });
    const reorder = await proposeReorder(SHOPPER);
    if (!("actionId" in reorder)) throw new Error("expected reorder");
    expect(verifyAction(reorder.actionId, "action-secret")?.action).toEqual({
      op: "add_to_cart",
      productId: "ethiopia-250",
      qty: 1,
    });
    expect((await commitAction(SHOPPER, reorder.actionId, shopper)).ok).toBe(true);
    await flush();
    expect(added()).toHaveLength(0);
  });

  it("still confirms the cart when the BI write fails", async () => {
    await rememberShownRecommendation(SHOPPER, SESSION, SERVER_REC, ["mug"]);
    const pending = await proposeAction(SHOPPER, { op: "add_to_cart", productId: "mug", qty: 1 }, { sessionId: SESSION });
    if (!("actionId" in pending)) throw new Error("expected pending");
    recorded.fail = true;
    const done = await confirm(confirmRequest(pending.actionId));
    expect(done.status).toBe(200);
    await flush();
    expect(bags.meta.get(SHOPPER)?.cart).toMatchObject({ items: [{ productId: "mug", qty: 1 }] });
    expect(added()).toHaveLength(0);
  });
});
