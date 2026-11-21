/** Connected-agents types and wording. Client-safe: no server imports. */

export type OutsideAgent = {
  id: string;
  name: string;
  connectedAt: string;
  lastActiveAt: string | null;
  capCents: number;
  paused: boolean;
  revokedAt: string | null;
};

export type BaristaAgent = {
  consented: boolean;
  capCents: number;
  paused: boolean;
  lastActiveAt: string | null;
};

export type AgentsView = {
  /** Server time of this read; relative times are worded from it so the first render is stable. */
  now: string;
  barista: BaristaAgent;
  outside: OutsideAgent[];
  /** The outside agents are a demo list until real identities ship. Always true in this slice. */
  demo: true;
};

function sgd(cents: number): string {
  return `S$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function limitLabel(agent: { capCents: number; consented?: boolean }): string {
  if (agent.consented === false) return `Not set up yet. Up to ${sgd(agent.capCents)} per order once you allow it`;
  return `Up to ${sgd(agent.capCents)} per order, asks first`;
}

export function ago(iso: string, nowIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function outsideSubline(agent: OutsideAgent, nowIso: string): string {
  if (agent.revokedAt) return `Revoked ${ago(agent.revokedAt, nowIso)}`;
  const connected = `Connected ${shortDate(agent.connectedAt)}`;
  return agent.lastActiveAt ? `${connected} · Last active ${ago(agent.lastActiveAt, nowIso)}` : connected;
}
