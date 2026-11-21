import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as agentsGet, POST as agentsPost } from "@/app/api/agent/agents/route";
import { POST as confirm } from "@/app/api/chat/confirm/route";
import { normalizeActivity } from "@/lib/agent-activity";
import { activitySentence } from "@/lib/agent-activity-text";
import { applyOutsideAction, normalizeOutsideAgents, seedOutsideAgents } from "@/lib/connected-agents";
import { ago, limitLabel, outsideSubline } from "@/lib/connected-agents-text";
import { nextNudge } from "@/lib/nudge";
import { proposeAction } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";

const SUB = "auth0|shopper";
const NOW = new Date("2026-11-21T08:00:00.000Z");
const CONSENT_AT = "2026-11-01T00:00:00.000Z";

const nonces = vi.hoisted(() => ({ ids: new Set<string>() }));
const db = vi.hoisted(() => ({ meta: {} as Record<string, unknown>, patches: 0 }));

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
    db.patches += 1;
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

type View = {
  barista: { consented: boolean; capCents: number; paused: boolean; lastActiveAt: string | null };
  outside: Array<{ id: string; name: string; capCents: number; paused: boolean; revokedAt: string | null }>;
  demo: boolean;
};

function post(body: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) {
  return new Request("http://localhost/api/agent/agents", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function act(body: unknown) {
  const res = await agentsPost(post(body));
  return { status: res.status, body: (await res.json()) as View & { error?: string } };
}

function audit() {
  return normalizeActivity(db.meta.agent_activity);
}

const prefs = (extra: Record<string, unknown> = {}) => ({ consentAt: CONSENT_AT, capCents: 6000, ...extra });

beforeEach(() => {
  nonces.ids.clear();
  db.meta = {};
  db.patches = 0;
  process.env.APPROVAL_SECRET = "action-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  delete process.env.DATABASE_URL;
  vi.mocked(getShopper).mockResolvedValue({ id: SUB, email: "a@example.com", name: "Ada" });
});

afterEach(() => {
  delete process.env.APPROVAL_SECRET;
  delete process.env.APP_BASE_URL;
});

describe("connected agents view", () => {
  it("requires a signed-in shopper", async () => {
    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await agentsGet()).status).toBe(401);
  });

  it("shows Barista and the labelled demo agents without writing anything", async () => {
    db.meta = { agent_prefs: prefs() };
    const res = await agentsGet();
    expect(res.headers.get("cache-control")).toContain("no-store");
    const view = (await res.json()) as View;
    expect(view.demo).toBe(true);
    expect(view.barista).toMatchObject({ consented: true, capCents: 6000, paused: false });
    expect(view.outside.map((agent) => agent.name)).toEqual(["ChatGPT shopping", "Gemini"]);
    expect(db.patches).toBe(0);
    expect(db.meta.outside_agents).toBeUndefined();
  });

  it("words limits and times the way the mockup does", () => {
    expect(limitLabel({ capCents: 6000, consented: true })).toBe("Up to S$60 per order, asks first");
    expect(limitLabel({ capCents: 6000, consented: false })).toContain("Not set up yet");
    expect(ago("2026-11-21T07:58:00Z", NOW.toISOString())).toBe("2 min ago");
    expect(ago("2026-11-21T06:00:00Z", NOW.toISOString())).toBe("2h ago");
    const [chatgpt] = seedOutsideAgents(NOW);
    expect(outsideSubline(chatgpt!, NOW.toISOString())).toBe("Connected 12 Nov · Last active 2h ago");
    expect(outsideSubline({ ...chatgpt!, revokedAt: NOW.toISOString() }, NOW.toISOString())).toBe("Revoked just now");
  });
});

describe("Barista pause and limit", () => {
  it("pauses and resumes through agent_prefs, keeping other prefs, and audits both", async () => {
    db.meta = { agent_prefs: prefs({ lastNudgeSession: "nudge_x" }) };
    const paused = await act({ agentId: "barista", action: "pause" });
    expect(paused.status).toBe(200);
    expect(paused.body.barista.paused).toBe(true);
    expect(db.meta.agent_prefs).toMatchObject({ paused: true, lastNudgeSession: "nudge_x", consentAt: CONSENT_AT });

    const resumed = await act({ agentId: "barista", action: "resume" });
    expect(resumed.body.barista.paused).toBe(false);
    expect(audit().map((row) => row.action).sort()).toEqual(["pause", "resume"]);
    expect(audit().every((row) => row.agent === "barista" && row.status === "done" && row.consent === CONSENT_AT)).toBe(true);
  });

  it("rejects a pause that changes nothing", async () => {
    db.meta = { agent_prefs: prefs({ paused: true }) };
    expect((await act({ agentId: "barista", action: "pause" })).status).toBe(409);
    expect((await act({ agentId: "barista", action: "resume" })).status).toBe(200);
    expect((await act({ agentId: "barista", action: "resume" })).status).toBe(409);
  });

  it("a paused Barista cannot be asked to place an order, and an earlier confirmation is refused", async () => {
    db.meta = { cart: { items: [{ productId: "ethiopia-250", qty: 1 }], coupon: null }, agent_prefs: prefs() };
    const pending = await proposeAction(SUB, { op: "place_order" });
    if (!("actionId" in pending)) throw new Error("expected pending");
    await act({ agentId: "barista", action: "pause" });

    expect(await proposeAction(SUB, { op: "place_order" })).toEqual({ error: "agent_paused" });
    const res = await confirm(
      new Request("http://localhost/api/chat/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ actionId: pending.actionId }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("agent_paused");
    expect(db.meta.orders).toBeUndefined();

    await act({ agentId: "barista", action: "resume" });
    expect(await proposeAction(SUB, { op: "place_order" })).toMatchObject({ pending: true });
  });

  it("a paused Barista shows no nudge", async () => {
    db.meta = { agent_prefs: prefs({ paused: true }) };
    expect(await nextNudge(SUB, "nudge_abc123", NOW)).toMatchObject({ nudge: null, skip: "paused" });
  });

  it("saves a new per-order limit, audits it once consented, and validates the range", async () => {
    db.meta = { agent_prefs: prefs() };
    const saved = await act({ agentId: "barista", action: "limit", capCents: 10000 });
    expect(saved.body.barista.capCents).toBe(10000);
    expect(audit()[0]).toMatchObject({ action: "consent", agent: "barista", amountCents: 10000 });

    for (const capCents of [100, 60000, 60.5, "6000"]) {
      expect((await act({ agentId: "barista", action: "limit", capCents })).status, String(capCents)).toBe(400);
    }
    expect((await act({ agentId: "barista", action: "limit", capCents: 10000 })).status).toBe(409);
  });

  it("does not audit a limit saved before any consent", async () => {
    await act({ agentId: "barista", action: "limit", capCents: 3000 });
    expect(audit()).toHaveLength(0);
    expect(db.meta.agent_prefs).toMatchObject({ capCents: 3000 });
  });

  it("cannot revoke the built-in agent", async () => {
    expect((await act({ agentId: "barista", action: "revoke" })).status).toBe(404);
  });
});

describe("outside agents (demo data)", () => {
  it("revoke marks the agent revoked, stores the list, and writes an audit entry in the same patch", async () => {
    db.meta = { agent_prefs: prefs() };
    const { status, body } = await act({ agentId: "gemini", action: "revoke" });
    expect(status).toBe(200);
    expect(db.patches).toBe(1);
    expect(body.outside.find((agent) => agent.id === "gemini")?.revokedAt).toBeTruthy();
    expect(body.outside.find((agent) => agent.id === "chatgpt-shopping")?.revokedAt).toBeNull();
    expect((db.meta.outside_agents as unknown[]).length).toBe(2);
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ action: "revoke", agent: "gemini", subject: "Gemini", status: "done", consent: CONSENT_AT });
    expect(activitySentence(audit()[0]!)).toBe("You revoked Gemini");
  });

  it("a revoked agent accepts nothing further", async () => {
    await act({ agentId: "gemini", action: "revoke" });
    expect((await act({ agentId: "gemini", action: "revoke" })).status).toBe(409);
    expect((await act({ agentId: "gemini", action: "pause" })).status).toBe(409);
    expect((await act({ agentId: "gemini", action: "limit", capCents: 6000 })).status).toBe(409);
    expect(audit()).toHaveLength(1);
  });

  it("pauses, resumes and changes the limit of one agent only", async () => {
    await act({ agentId: "chatgpt-shopping", action: "pause" });
    let view = (await (await agentsGet()).json()) as View;
    expect(view.outside.map((agent) => agent.paused)).toEqual([true, false]);
    await act({ agentId: "chatgpt-shopping", action: "resume" });
    await act({ agentId: "chatgpt-shopping", action: "limit", capCents: 3000 });
    view = (await (await agentsGet()).json()) as View;
    expect(view.outside.map((agent) => [agent.paused, agent.capCents])).toEqual([
      [false, 3000],
      [false, 3000],
    ]);
    expect(audit().map((row) => row.action).sort()).toEqual(["consent", "pause", "resume"]);
    expect(audit().find((row) => row.action === "consent")?.amountCents).toBe(3000);
  });

  it("rejects unknown agents, bad bodies, a missing origin and a signed-out shopper", async () => {
    expect((await act({ agentId: "nobody", action: "pause" })).status).toBe(404);
    for (const body of [
      { agentId: "gemini" },
      { agentId: "gemini", action: "delete" },
      { agentId: "Gemini!", action: "pause" },
      { agentId: "gemini", action: "pause", extra: 1 },
      { agentId: "gemini", action: "limit" },
    ]) {
      expect((await act(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await agentsPost(post({ agentId: "gemini", action: "revoke" }, {}))).status).toBe(403);
    expect(db.meta.outside_agents).toBeUndefined();

    vi.mocked(getShopper).mockResolvedValue(null);
    expect((await act({ agentId: "gemini", action: "revoke" })).status).toBe(401);
  });
});

describe("outside agent helpers", () => {
  it("applyOutsideAction is pure and refuses no-ops", () => {
    const agents = seedOutsideAgents(NOW);
    const next = applyOutsideAction(agents, "gemini", { action: "revoke" }, NOW);
    if ("error" in next) throw new Error(next.error);
    expect(next.agent.revokedAt).toBe(NOW.toISOString());
    expect(agents[1]?.revokedAt).toBeNull();
    expect(applyOutsideAction(agents, "gemini", { action: "resume" }, NOW)).toEqual({ error: "no_change" });
    expect(applyOutsideAction(agents, "gemini", { action: "limit", capCents: 3000 }, NOW)).toEqual({ error: "no_change" });
    expect(applyOutsideAction(agents, "gemini", { action: "limit", capCents: 1 }, NOW)).toEqual({ error: "invalid_cap" });
  });

  it("drops malformed stored agents, and an emptied list stays empty instead of reseeding", () => {
    expect(normalizeOutsideAgents(undefined, NOW)).toHaveLength(2);
    expect(normalizeOutsideAgents([], NOW)).toEqual([]);
    expect(normalizeOutsideAgents("nope", NOW)).toEqual([]);
    const good = seedOutsideAgents(NOW)[0]!;
    const rows = normalizeOutsideAgents(
      [good, good, { ...good, id: "BAD ID" }, { ...good, id: "x", name: "" }, { ...good, id: "y", capCents: 1 }, null],
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["chatgpt-shopping"]);
  });
});
