"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CAP_PRESETS_CENTS } from "@/lib/agent-cap";
import { ago, limitLabel, outsideSubline, type AgentsView, type OutsideAgent } from "@/lib/connected-agents-text";
import { Spark } from "./Spark";

type Target = { id: string; name: string };

const FAILED = "That didn't work. Please try again.";

function chipLabel(cents: number): string {
  return `S$${cents / 100}`;
}

function CapEditor({
  current,
  busy,
  onSave,
  onCancel,
}: {
  current: number;
  busy: boolean;
  onSave: (cents: number) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<number>(current);
  return (
    <div className="border-t border-stone-200 px-4 py-3">
      <div role="radiogroup" aria-label="Limit per order" className="mb-3 grid grid-cols-3 gap-2">
        {CAP_PRESETS_CENTS.map((cents) => (
          <button
            key={cents}
            type="button"
            role="radio"
            aria-checked={choice === cents}
            onClick={() => setChoice(cents)}
            className={`h-11 rounded text-[15px] ${
              choice === cents
                ? "border-2 border-amber-700 bg-amber-50 font-semibold text-amber-900"
                : "border border-stone-300 font-medium text-stone-700"
            }`}
          >
            {chipLabel(cents)}
          </button>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-stone-700">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(choice)}
          disabled={busy || choice === current}
          className="min-h-11 rounded bg-amber-700 px-4 text-[15px] font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function RevokeDialog({ target, busy, onConfirm, onCancel }: { target: Target; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center px-6 font-sans text-[15px] text-stone-900">
      <div className="absolute inset-0 bg-stone-900/50" aria-hidden="true" onClick={onCancel} />
      <div role="dialog" aria-modal="true" aria-labelledby="revoke-title" className="relative w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <h2 id="revoke-title" className="mb-2 text-[19px] font-semibold tracking-tight">
          Revoke {target.name}?
        </h2>
        <p className="mb-5 leading-snug text-stone-600">It won&apos;t be able to see your orders or buy for you. Past orders aren&apos;t affected.</p>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="mb-1 inline-flex h-12 w-full items-center justify-center rounded bg-[#bf000f] text-[15px] font-medium text-white disabled:opacity-50"
        >
          Revoke
        </button>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex h-12 w-full items-center justify-center rounded text-[15px] font-medium text-stone-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Foot({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-1 border-t border-stone-200 px-2">{children}</div>;
}

const TEXT_BTN = "min-h-11 rounded px-3 text-[15px] font-medium disabled:opacity-50";

function Card({
  avatar,
  title,
  badge,
  subline,
  limit,
  paused,
  editing,
  busy,
  onEdit,
  onSaveLimit,
  onCancelEdit,
  onTogglePause,
  onRevoke,
  capCents,
}: {
  avatar: React.ReactNode;
  title: string;
  badge?: string;
  subline: string;
  limit: string;
  paused: boolean;
  editing: boolean;
  busy: boolean;
  capCents: number;
  onEdit: () => void;
  onSaveLimit: (cents: number) => void;
  onCancelEdit: () => void;
  onTogglePause: () => void;
  onRevoke?: () => void;
}) {
  return (
    <li className="mb-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-center gap-3 px-4 py-3.5">
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[17px] font-semibold tracking-tight">
            {title}
            {badge && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">{badge}</span>}
            {paused && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">Paused</span>}
          </div>
          <div className="text-[13px] text-stone-500">{subline}</div>
        </div>
      </div>
      <div className="flex min-h-12 items-center justify-between border-t border-stone-200 px-4 text-[15px] text-stone-700">
        <span>{limit}</span>
        {!editing && (
          <button type="button" onClick={onEdit} disabled={busy} className="min-h-11 pl-3 font-medium text-amber-700 disabled:opacity-50">
            Edit
          </button>
        )}
      </div>
      {editing && <CapEditor current={capCents} busy={busy} onSave={onSaveLimit} onCancel={onCancelEdit} />}
      <Foot>
        <button type="button" onClick={onTogglePause} disabled={busy} className={`${TEXT_BTN} text-stone-700`}>
          {paused ? "Resume" : "Pause"}
        </button>
        {onRevoke && (
          <button type="button" onClick={onRevoke} disabled={busy} className={`${TEXT_BTN} text-[#bf000f]`}>
            Revoke
          </button>
        )}
      </Foot>
    </li>
  );
}

function OutsideAvatar({ agent }: { agent: OutsideAgent }) {
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[17px] font-semibold ${
        agent.revokedAt ? "bg-stone-200 text-stone-500" : "bg-stone-800 text-white"
      }`}
    >
      {agent.name.charAt(0)}
    </span>
  );
}

export function ConnectedAgents({ initial }: { initial: AgentsView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Target | null>(null);

  async function send(agentId: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, ...body }),
      });
      if (!res.ok) {
        setError(res.status === 409 ? "That already changed. Refresh to see the latest." : FAILED);
        return false;
      }
      setView((await res.json()) as AgentsView);
      return true;
    } catch {
      setError("Connection dropped. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(agentId: string, capCents: number) {
    if (await send(agentId, { action: "limit", capCents })) setEditing(null);
  }

  async function confirmRevoke() {
    if (!revoking) return;
    const ok = await send(revoking.id, { action: "revoke" });
    if (ok) setRevoking(null);
  }

  const { barista, outside } = view;
  return (
    <div className="px-4 pb-10 pt-4">
      <p className="mb-4 text-[15px] leading-snug text-stone-600">Agents that can find coffee and order for you. You confirm every order.</p>
      {error && (
        <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <ul>
        <Card
          avatar={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-amber-100 bg-amber-50">
              <Spark size={20} />
            </span>
          }
          title="Barista"
          badge="Built in"
          subline={barista.lastActiveAt ? `Last active ${ago(barista.lastActiveAt, view.now)}` : "Not used yet"}
          limit={limitLabel(barista)}
          paused={barista.paused}
          editing={editing === "barista"}
          busy={busy}
          capCents={barista.capCents}
          onEdit={() => setEditing("barista")}
          onSaveLimit={(cents) => void saveLimit("barista", cents)}
          onCancelEdit={() => setEditing(null)}
          onTogglePause={() => void send("barista", { action: barista.paused ? "resume" : "pause" })}
        />
        {outside.map((agent) =>
          agent.revokedAt ? (
            <li key={agent.id} className="mb-3 flex items-center gap-3 rounded-lg border border-dashed border-stone-300 px-4 py-3.5 opacity-80">
              <OutsideAvatar agent={agent} />
              <div>
                <div className="text-[17px] font-semibold tracking-tight text-stone-500">{agent.name}</div>
                <div className="text-[13px] text-stone-500">{outsideSubline(agent, view.now)}</div>
              </div>
            </li>
          ) : (
            <Card
              key={agent.id}
              avatar={<OutsideAvatar agent={agent} />}
              title={agent.name}
              subline={outsideSubline(agent, view.now)}
              limit={limitLabel(agent)}
              paused={agent.paused}
              editing={editing === agent.id}
              busy={busy}
              capCents={agent.capCents}
              onEdit={() => setEditing(agent.id)}
              onSaveLimit={(cents) => void saveLimit(agent.id, cents)}
              onCancelEdit={() => setEditing(null)}
              onTogglePause={() => void send(agent.id, { action: agent.paused ? "resume" : "pause" })}
              onRevoke={() => setRevoking({ id: agent.id, name: agent.name })}
            />
          ),
        )}
      </ul>
      <Link
        href="/account/activity"
        className="mt-1 flex min-h-12 items-center justify-between rounded-lg border border-stone-200 bg-white px-4 text-[15px] font-medium"
      >
        <span className="flex items-center gap-2">
          <Spark size={14} />
          Agent activity
        </span>
        <span aria-hidden="true" className="text-stone-400">
          ›
        </span>
      </Link>
      {revoking && <RevokeDialog target={revoking} busy={busy} onConfirm={() => void confirmRevoke()} onCancel={() => setRevoking(null)} />}
    </div>
  );
}
