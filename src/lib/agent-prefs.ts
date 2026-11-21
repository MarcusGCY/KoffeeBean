import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { normalizeAgentPrefs } from "./store-meta";
import type { AgentPrefs } from "./store-types";

export const SNOOZE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type PrefsChange = Partial<Pick<AgentPrefs, "consentAt" | "capCents" | "snoozeUntil" | "lastNudgeSession" | "paused">>;

function storedPrefs(meta: Record<string, unknown>): Record<string, unknown> {
  const value = meta.agent_prefs;
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * Merges `changes` into the stored `agent_prefs` object and returns the normalized result.
 * Auth0 replaces top-level keys, so the whole object is written back.
 */
export async function updateAgentPrefs(userId: string, changes: PrefsChange): Promise<AgentPrefs> {
  const next = { ...storedPrefs(await getAppMetadata(userId)), ...changes };
  await patchAppMetadata(userId, { agent_prefs: next });
  return normalizeAgentPrefs(next);
}

/** Hides the Barista nudge for `SNOOZE_DAYS` days. Returns the ISO time it resumes. */
export async function snoozeNudges(userId: string, now = new Date()): Promise<string> {
  const snoozeUntil = new Date(now.getTime() + SNOOZE_DAYS * DAY_MS).toISOString();
  await updateAgentPrefs(userId, { snoozeUntil });
  return snoozeUntil;
}

export async function markNudgeSession(userId: string, session: string): Promise<void> {
  await updateAgentPrefs(userId, { lastNudgeSession: session });
}
