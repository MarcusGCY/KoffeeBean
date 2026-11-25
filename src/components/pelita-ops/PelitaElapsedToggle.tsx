"use client";

import { useState } from "react";
import { setElapsedModeRequest } from "@/lib/demo/ops-client";
import type { ElapsedMode } from "@/lib/demo/state";

const OPTIONS: { mode: ElapsedMode; label: string }[] = [
  { mode: "fixture", label: "Scripted" },
  { mode: "real", label: "Real" },
];

/**
 * Presenter control for where the elapsed time on screens 06 and 07 comes from: the scripted
 * fixture figure (the default) or the real time between the detection and publish rows.
 * Neutral on purpose: it is neither an agent action nor a human approval.
 */
export function PelitaElapsedToggle({ mode }: { mode: ElapsedMode }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function choose(next: ElapsedMode) {
    if (next === mode || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await setElapsedModeRequest(next);
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  return (
    <div role="group" aria-label="Elapsed time source" data-elapsed-toggle data-elapsed-mode={mode} className="flex items-center gap-2 whitespace-nowrap text-base font-semibold text-ink-3">
      <span>Elapsed</span>
      <div className="flex overflow-hidden rounded-md border-2 border-line-2">
        {OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            aria-pressed={option.mode === mode}
            disabled={busy}
            onClick={() => choose(option.mode)}
            className={`px-2.5 py-0.5 text-base font-semibold leading-6 disabled:opacity-60 ${option.mode === mode ? "bg-ink text-white" : "bg-surface text-ink-2"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {failed && <span role="alert" className="text-ink-2">Not saved</span>}
    </div>
  );
}
