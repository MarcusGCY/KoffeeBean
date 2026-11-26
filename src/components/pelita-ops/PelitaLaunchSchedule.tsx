"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { goLiveNowRequest } from "@/lib/demo/launch-client";
import type { LaunchScheduleRow } from "@/lib/demo/launch";

const STATUS_CLASS = {
  draft: "bg-line-2 text-ink",
  scheduled: "bg-promo text-ink",
  live: "bg-success-50 text-success-text",
} as const;

/** Ops list of Redis launch configs. Go live now is a same-origin demo action. */
export function PelitaLaunchSchedule({ rows }: { rows: LaunchScheduleRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [forcedLive, setForcedLive] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function goLive(sku: string) {
    setPending(sku);
    setError(null);
    try {
      await goLiveNowRequest(sku);
      setForcedLive((current) => new Set(current).add(sku));
      router.refresh();
    } catch {
      setError("Could not go live. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section data-launch-schedule aria-labelledby="launch-schedule-heading" className="mb-6 rounded-xl border border-line-2 bg-surface px-8 py-6">
      <h2 id="launch-schedule-heading" className="text-h2 font-extrabold tracking-[-0.3px]">
        Launch Schedule & Configs
      </h2>
      <ul className="mt-4 flex flex-col gap-3">
        {rows.map((row) => {
          const live = row.isLive || forcedLive.has(row.sku);
          return (
            <li key={row.sku} data-launch-sku={row.sku} data-launch-live={live ? "1" : "0"} className="rounded-lg border border-line-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-lg font-extrabold">{row.title}</p>
                <span className="text-base font-semibold text-ink-3">{row.sku}</span>
                <span data-launch-status={row.status} className={`rounded-full px-3 py-0.5 text-base font-bold ${STATUS_CLASS[row.status]}`}>
                  {row.status}
                </span>
                <span className="text-base font-bold text-ink-2">{live ? "Live now" : "Not live yet"}</span>
              </div>
              <p data-go-live-at className="mt-1 text-base font-semibold text-ink-2">
                {row.goLiveLabel ? `Go-live ${row.goLiveLabel}` : "No go-live time"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                <a href={row.previewUrl} className="text-base font-bold text-primary underline underline-offset-4">
                  Preview
                </a>
                {live && (
                  <a href={row.liveUrl} className="text-base font-bold text-primary underline underline-offset-4">
                    Live
                  </a>
                )}
                {!live && (
                  <button
                    type="button"
                    data-go-live={row.sku}
                    disabled={pending !== null}
                    onClick={() => void goLive(row.sku)}
                    className="h-10 rounded-md bg-primary px-4 text-base font-bold text-white disabled:opacity-60"
                  >
                    {pending === row.sku ? "Going live…" : "Go live now"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-base font-bold text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
