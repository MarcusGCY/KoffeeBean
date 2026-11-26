"use client";

import { useState } from "react";
import { refreshYuuSignalsRequest } from "@/lib/demo/yuu-client";
import type { YuuPanel, YuuSignalStatus } from "@/lib/yuu/types";

const ORDER: readonly YuuSignalStatus[] = ["escalated", "shortlisted", "dropped"];

const TITLES: Record<YuuSignalStatus, string> = {
  escalated: "Escalated",
  shortlisted: "Shortlisted",
  dropped: "Dropped",
};

/** "1 member", "2 members". Zero and every other count take the plural. */
function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Ops view of yuu signals. Members are signed-in shoppers, labelled by a hash prefix. */
export function PelitaYuuPanel({ initial }: { initial: YuuPanel | null }) {
  const [panel, setPanel] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      setPanel(await refreshYuuSignalsRequest());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not refresh yuu signals.");
    } finally {
      setBusy(false);
    }
  }

  const signals = panel?.signals ?? [];

  return (
    <section id="yuu-loyalty" data-yuu-panel aria-labelledby="yuu-loyalty-heading" className="mx-12 mb-10 rounded-xl border border-line-2 bg-surface px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="yuu-loyalty-heading" className="text-h2 font-extrabold tracking-[-0.3px]">
            yuu loyalty signals
          </h2>
          <p className="text-base font-semibold text-ink-3">
            yuu (simulated) · signed-in shoppers
            {panel ? ` · window of ${counted(panel.windowMinutes, "minute")}` : ""}
            {panel ? ` · escalates at ${panel.minRepeatMembers} repeat shoppers and score ${panel.minScore}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="h-12 rounded-md bg-primary px-5 text-base font-bold text-white disabled:opacity-60"
        >
          {busy ? "Refreshing…" : "Refresh signals"}
        </button>
      </div>

      {!panel && <p className="mt-4 text-base font-semibold text-ink-2">No loyalty rows loaded yet.</p>}
      {panel && !panel.scanComplete && (
        <p className="mt-3 text-base font-semibold text-ink-3">Shopper scan is incomplete, so some purchases may be missing.</p>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {ORDER.map((status) => {
          const rows = signals.filter((signal) => signal.status === status);
          return (
            <div key={status} className="rounded-lg border border-line-2 bg-[#f8fafc] px-4 py-3">
              <h3 className="text-base font-extrabold">{TITLES[status]}</h3>
              {rows.length === 0 ? (
                <p className="mt-2 text-base text-ink-3">None</p>
              ) : (
                <ul className="mt-2 space-y-3">
                  {rows.map((signal) => (
                    <li key={signal.id || signal.sku} data-yuu-signal={signal.sku} data-yuu-status={signal.status}>
                      <p className="font-bold">{signal.productName}</p>
                      <p className="text-base text-ink-2">
                        score {signal.score} · {counted(signal.distinctMembers, "member")} · qty {signal.totalQty}
                      </p>
                      <p className="text-base text-ink-3">
                        {signal.reason ?? "—"} · {signal.source === "bi_bot" ? "bi bot" : "detector"}
                        {signal.proposalRef ? ` · ${signal.proposalRef}` : ""}
                      </p>
                      {signal.status === "escalated" && signal.webhook && (
                        <p className="text-base font-semibold text-ink-2" data-yuu-webhook={signal.webhook.status}>
                          {signal.webhook.status === "sent" && "webhook sent"}
                          {signal.webhook.status === "failed" &&
                            `webhook failed${signal.webhook.code == null ? "" : ` ${signal.webhook.code}`}`}
                          {signal.webhook.status === "unconfigured" && "webhook not configured"}
                          {signal.webhook.status === "pending" && "webhook sending"}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {panel && panel.members.length > 0 && (
        <div className="mt-5">
          <h3 className="text-base font-extrabold">Members and points</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {panel.members.map((member) => (
              <li key={member.id} className="rounded-full border border-line-2 bg-surface px-3 py-1 text-base font-semibold">
                {member.displayName} · {counted(member.points, "pt")} · {member.tier}
                {member.test ? " · test" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-base font-bold text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
