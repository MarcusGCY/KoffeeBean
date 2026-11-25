"use client";

import { useState } from "react";
import { simulateYuuBurstRequest } from "@/lib/demo/yuu-client";
import type { YuuPanel, YuuSignalStatus } from "@/lib/yuu/types";

const ORDER: readonly YuuSignalStatus[] = ["escalated", "shortlisted", "dropped"];

const TITLES: Record<YuuSignalStatus, string> = {
  escalated: "Escalated",
  shortlisted: "Shortlisted",
  dropped: "Dropped",
};

/** Ops view of simulated yuu signals and member points. */
export function PelitaYuuPanel({ initial }: { initial: YuuPanel | null }) {
  const [panel, setPanel] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function simulate() {
    setBusy(true);
    setError(null);
    try {
      setPanel(await simulateYuuBurstRequest());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not simulate the yuu burst.");
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
            yuu (simulated)
            {panel ? ` · ${panel.windowMinutes} minute window` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void simulate()}
          disabled={busy}
          className="h-12 rounded-md bg-primary px-5 text-base font-bold text-white disabled:opacity-60"
        >
          {busy ? "Simulating…" : "Simulate yuu burst"}
        </button>
      </div>

      {!panel && <p className="mt-4 text-base font-semibold text-ink-2">No loyalty rows loaded yet.</p>}

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
                        score {signal.score} · {signal.distinctMembers} members · qty {signal.totalQty}
                      </p>
                      <p className="text-base text-ink-3">
                        {signal.reason ?? "—"} · {signal.source === "bi_bot" ? "bi bot" : "detector"}
                        {signal.proposalRef ? ` · ${signal.proposalRef}` : ""}
                      </p>
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
                {member.displayName} · {member.points} pts · {member.tier}
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
