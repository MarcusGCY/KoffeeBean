"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  STATUS_LABEL,
  activitySentence,
  agentDisplayName,
  BARISTA,
  type ActivityGroup,
  type ActivityStatus,
} from "@/lib/agent-activity-text";
import { sgd } from "@/lib/chat-response";
import { formatCountdown, undoSecondsLeft } from "@/lib/nudge-client";
import type { ActivityRow } from "@/lib/store-meta";
import { Spark } from "./Spark";

export type ActivityGroupView = Omit<ActivityGroup, "entries"> & { entries: ActivityRow[] };

const PILL: Record<ActivityStatus, string> = {
  done: "border border-green-100 bg-green-50 text-green-700",
  waiting: "bg-amber-100 text-amber-900",
  declined: "bg-stone-100 text-stone-600",
  undone: "border border-stone-300 bg-white text-stone-600",
};

function Avatar({ agent }: { agent: string }) {
  if (agent === BARISTA) {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-100 bg-amber-50">
        <Spark size={16} />
      </span>
    );
  }
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-800 text-sm font-semibold text-white">
      {agentDisplayName(agent).charAt(0)}
    </span>
  );
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
  const left = undoSecondsLeft(until, now);
  return left > 0 ? <span className="text-[13px] text-stone-500">· {formatCountdown(left)} left</span> : null;
}

function Row({ row, open, onToggle }: { row: ActivityRow; open: boolean; onToggle: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = row.status === "waiting";

  async function undo() {
    if (!row.orderId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(row.orderId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(res.status === 409 ? "This order can no longer be undone." : "That didn't work. Please try again.");
    } catch {
      setError("Connection dropped. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`border-b border-stone-200 ${waiting ? "bg-amber-50" : "bg-white"}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-16 w-full items-start gap-3 px-4 py-3 text-left"
      >
        <Avatar agent={row.agent} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-snug text-stone-900">{activitySentence(row)}</span>
          <span className="mt-1 flex items-center gap-2 text-[13px] text-stone-500">
            <time dateTime={row.ts} suppressHydrationWarning>
              {new Date(row.ts).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
            </time>
            <span className={`inline-flex h-[22px] items-center rounded-full px-2 text-xs font-medium ${PILL[row.status]}`}>
              {STATUS_LABEL[row.status]}
            </span>
          </span>
        </span>
        <span aria-hidden="true" className="self-center text-stone-400">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3 pl-[60px] text-sm text-stone-700">
          <p>{row.reason}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] text-stone-600">
            <dt className="text-stone-500">Agent</dt>
            <dd>{agentDisplayName(row.agent)}</dd>
            {row.amountCents != null && (
              <>
                <dt className="text-stone-500">Amount</dt>
                <dd>{sgd(row.amountCents)}</dd>
              </>
            )}
            {row.orderId && (
              <>
                <dt className="text-stone-500">Order</dt>
                <dd>{row.orderId}</dd>
              </>
            )}
            <dt className="text-stone-500">Consent</dt>
            <dd>{row.consent ? "You allowed Barista to order for you" : "None needed yet"}</dd>
          </dl>
          {row.undoUntil && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void undo()}
                disabled={busy}
                className="inline-flex min-h-11 items-center rounded border border-stone-300 bg-white px-3 text-[15px] font-medium text-amber-700 disabled:opacity-50"
              >
                Undo this order
              </button>
              <Countdown until={row.undoUntil} />
            </div>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function ActivityList({ groups }: { groups: ActivityGroupView[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (groups.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-[15px] text-stone-500">
        Nothing yet. When Barista suggests or orders something, it shows up here.
      </p>
    );
  }
  return (
    <div>
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h2 className="border-b border-stone-200 bg-stone-50 px-4 pb-1 pt-4 text-[13px] font-semibold uppercase tracking-wider text-stone-500">
            {group.label}
          </h2>
          <ul>
            {group.entries.map((row) => (
              <Row key={row.id} row={row} open={openId === row.id} onToggle={() => setOpenId(openId === row.id ? null : row.id)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={label} className="inline-flex h-11 w-11 items-center justify-center rounded text-stone-900">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </Link>
  );
}
