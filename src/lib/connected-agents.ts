import { randomBytes } from "node:crypto";
import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { consentAtOf, newActivityId, normalizeActivity, recordActivity, upsertActivity, bestEffort } from "./agent-activity";
import { BARISTA, type ActivityEntry } from "./agent-activity-text";
import { updateAgentPrefs } from "./agent-prefs";
import { validCap } from "./agent-cap";
import type { AgentsView, OutsideAgent } from "./connected-agents-text";
import { normalizeShopperFlags } from "./store-meta";

const MAX_AGENTS = 8;
const NAME_MAX = 40;
const ID = /^[a-z0-9-]{1,32}$/;
const SETTINGS_ACTIONS: readonly ActivityEntry["action"][] = ["consent", "pause", "resume", "revoke"];
const HOUR_MS = 60 * 60 * 1000;

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** Slice-1 demo data. Real outside-agent identities replace this in slice 2. */
export function seedOutsideAgents(now: Date): OutsideAgent[] {
  return [
    {
      id: "chatgpt-shopping",
      name: "ChatGPT shopping",
      connectedAt: "2026-11-12T09:00:00.000Z",
      lastActiveAt: new Date(now.getTime() - 2 * HOUR_MS).toISOString(),
      capCents: 6000,
      paused: false,
      revokedAt: null,
    },
    {
      id: "gemini",
      name: "Gemini",
      connectedAt: "2026-11-14T09:00:00.000Z",
      lastActiveAt: new Date(now.getTime() - 26 * HOUR_MS).toISOString(),
      capCents: 3000,
      paused: false,
      revokedAt: null,
    },
  ];
}

/** Defensive read of `app_metadata.outside_agents`. A key that was never stored shows the demo list. */
export function normalizeOutsideAgents(value: unknown, now: Date): OutsideAgent[] {
  if (value === undefined) return seedOutsideAgents(now);
  if (!Array.isArray(value)) return [];
  const rows: OutsideAgent[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !ID.test(r.id) || rows.some((agent) => agent.id === r.id)) continue;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, NAME_MAX) : "";
    if (!name || !isIso(r.connectedAt) || !validCap(r.capCents)) continue;
    rows.push({
      id: r.id,
      name,
      connectedAt: r.connectedAt,
      lastActiveAt: isIso(r.lastActiveAt) ? r.lastActiveAt : null,
      capCents: r.capCents,
      paused: r.paused === true,
      revokedAt: isIso(r.revokedAt) ? r.revokedAt : null,
    });
  }
  return rows.slice(0, MAX_AGENTS);
}

export type AgentAction =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "revoke" }
  | { action: "limit"; capCents: number };

export type AgentActionError = "not_found" | "revoked" | "already_revoked" | "invalid_cap" | "no_change";

/** Pure: applies one action to one outside agent. A revoked agent accepts nothing. */
export function applyOutsideAction(
  agents: readonly OutsideAgent[],
  id: string,
  act: AgentAction,
  now: Date,
): { agents: OutsideAgent[]; agent: OutsideAgent } | { error: AgentActionError } {
  const found = agents.find((agent) => agent.id === id);
  if (!found) return { error: "not_found" };
  if (found.revokedAt) return { error: act.action === "revoke" ? "already_revoked" : "revoked" };
  let next: OutsideAgent;
  if (act.action === "revoke") next = { ...found, revokedAt: now.toISOString(), paused: false };
  else if (act.action === "pause") next = { ...found, paused: true };
  else if (act.action === "resume") next = { ...found, paused: false };
  else {
    if (!validCap(act.capCents)) return { error: "invalid_cap" };
    next = { ...found, capCents: act.capCents };
  }
  if (next.paused === found.paused && next.capCents === found.capCents && next.revokedAt === found.revokedAt) {
    return { error: "no_change" };
  }
  return { agents: agents.map((agent) => (agent.id === id ? next : agent)), agent: next };
}

function lastActive(entries: readonly ActivityEntry[]): string | null {
  const mine = entries.filter((row) => row.agent === BARISTA && !SETTINGS_ACTIONS.includes(row.action));
  return mine.length ? mine.reduce((a, b) => (Date.parse(a.ts) >= Date.parse(b.ts) ? a : b)).ts : null;
}

export async function readAgentsView(userId: string, now = new Date()): Promise<AgentsView> {
  const meta = await getAppMetadata(userId);
  const prefs = normalizeShopperFlags(meta).agentPrefs;
  return {
    now: now.toISOString(),
    barista: {
      consented: Boolean(prefs.consentAt),
      capCents: prefs.capCents,
      paused: prefs.paused === true,
      lastActiveAt: lastActive(normalizeActivity(meta.agent_activity)),
    },
    outside: normalizeOutsideAgents(meta.outside_agents, now),
    demo: true,
  };
}

function entryFor(agent: string, name: string, act: AgentAction, now: Date): Omit<ActivityEntry, "consent"> {
  const base = {
    id: newActivityId(act.action, randomBytes(6).toString("hex")),
    ts: now.toISOString(),
    agent,
    subject: name,
    orderId: null,
    status: "done" as const,
  };
  if (act.action === "pause") return { ...base, action: "pause", reason: `You paused ${name}. It can't act for you until you resume it.`, amountCents: null };
  if (act.action === "resume") return { ...base, action: "resume", reason: `You resumed ${name}.`, amountCents: null };
  if (act.action === "revoke") return { ...base, action: "revoke", reason: `You revoked ${name}. It can no longer see your orders or buy for you.`, amountCents: null };
  return { ...base, action: "consent", reason: `You changed ${name}'s per-order limit.`, amountCents: act.capCents };
}

/**
 * Applies a pause, resume, revoke or limit change to Barista or one outside agent and audits it.
 * Barista's settings live in `agent_prefs`. An outside agent's change and its audit entry go in one patch.
 */
export async function changeAgent(
  userId: string,
  agentId: string,
  act: AgentAction,
  now = new Date(),
): Promise<{ view: AgentsView } | { error: AgentActionError }> {
  if (agentId === BARISTA) {
    if (act.action === "revoke") return { error: "not_found" };
    if (act.action === "limit" && !validCap(act.capCents)) return { error: "invalid_cap" };
    const current = normalizeShopperFlags(await getAppMetadata(userId)).agentPrefs;
    if (act.action === "pause" && current.paused === true) return { error: "no_change" };
    if (act.action === "resume" && current.paused !== true) return { error: "no_change" };
    if (act.action === "limit" && current.capCents === act.capCents) return { error: "no_change" };
    await updateAgentPrefs(
      userId,
      act.action === "limit" ? { capCents: act.capCents } : { paused: act.action === "pause" },
    );
    // A cap set before consent is not an action Barista took, so it is not audited.
    if (act.action !== "limit" || current.consentAt) {
      await bestEffort(recordActivity(userId, entryFor(BARISTA, "Barista", act, now)));
    }
    return { view: await readAgentsView(userId, now) };
  }

  const meta = await getAppMetadata(userId);
  const result = applyOutsideAction(normalizeOutsideAgents(meta.outside_agents, now), agentId, act, now);
  if ("error" in result) return result;
  const entry = { ...entryFor(agentId, result.agent.name, act, now), consent: consentAtOf(meta) };
  await patchAppMetadata(userId, {
    outside_agents: result.agents,
    agent_activity: upsertActivity(normalizeActivity(meta.agent_activity), entry),
  });
  return { view: await readAgentsView(userId, now) };
}
