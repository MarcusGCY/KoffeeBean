"use client";

import { useEffect, useState } from "react";
import { CAP_PRESETS_CENTS, DEFAULT_AGENT_CAP_CENTS, parseCustomCapDollars } from "@/lib/agent-cap";
import { sgd } from "@/lib/chat-response";
import { Spark } from "./Spark";

type Choice = number | "custom";

const POINTS = [
  "Barista can suggest and place coffee orders.",
  "You'll always confirm before an order is placed.",
  "You can change this anytime under Connected agents.",
];

/** One-time consent before Barista's first purchase: per-order cap chips and a locked-on confirm toggle. */
export function ConsentSheet({
  busy,
  error,
  onAllow,
  onDecline,
}: {
  busy: boolean;
  error: string | null;
  onAllow: (capCents: number) => void;
  onDecline: () => void;
}) {
  const [choice, setChoice] = useState<Choice>(DEFAULT_AGENT_CAP_CENTS);
  const [custom, setCustom] = useState("");
  const [how, setHow] = useState(false);
  const customCents = parseCustomCapDollars(custom);
  const capCents = choice === "custom" ? customCents : choice;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDecline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDecline]);

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center font-sans text-[15px] text-stone-900">
      <div className="absolute inset-0 bg-stone-900/50" aria-hidden="true" onClick={onDecline} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        className="relative max-h-dvh w-full max-w-md overflow-y-auto rounded-t-xl bg-white px-5 pb-8 pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]"
      >
        <div className="mx-auto mb-4 h-[5px] w-9 rounded-sm bg-stone-300" aria-hidden="true" />
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-[10px] border border-amber-100 bg-amber-50">
          <Spark size={22} />
        </div>
        <h2 id="consent-title" className="mb-3 text-[22px] font-semibold tracking-tight">
          Let Barista order for you?
        </h2>
        <ul className="mb-5 space-y-2">
          {POINTS.map((point) => (
            <li key={point} className="flex gap-2.5 leading-snug text-stone-700">
              <span aria-hidden="true" className="mt-0.5 text-green-700">
                ✓
              </span>
              {point}
            </li>
          ))}
        </ul>
        <p id="cap-label" className="mb-2 text-sm font-semibold">
          Spending cap per order
        </p>
        <div role="radiogroup" aria-labelledby="cap-label" className="mb-3 grid grid-cols-4 gap-2">
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
              {sgd(cents).replace(".00", "")}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={choice === "custom"}
            onClick={() => setChoice("custom")}
            className={`h-11 rounded text-[15px] ${
              choice === "custom"
                ? "border-2 border-amber-700 bg-amber-50 font-semibold text-amber-900"
                : "border border-stone-300 font-medium text-stone-700"
            }`}
          >
            Custom
          </button>
        </div>
        {choice === "custom" && (
          <div className="mb-3">
            <label htmlFor="custom-cap" className="mb-1 block text-sm text-stone-700">
              Custom cap in S$ (5 to 500)
            </label>
            <input
              id="custom-cap"
              inputMode="decimal"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              aria-invalid={custom !== "" && customCents === null}
              className="h-11 w-full rounded border border-stone-300 px-3"
              placeholder="e.g. 45"
            />
            {custom !== "" && customCents === null && (
              <p className="mt-1 text-[13px] text-red-700">Enter an amount from S$5 to S$500.</p>
            )}
          </div>
        )}
        <div className="mt-1 flex min-h-11 items-center justify-between border-t border-stone-200 pt-2.5">
          <span id="ask-label" className="font-medium">
            Ask me before every order
          </span>
          <span
            role="switch"
            aria-checked="true"
            aria-disabled="true"
            aria-labelledby="ask-label"
            className="relative inline-block h-[31px] w-[51px] shrink-0 rounded-full bg-amber-700"
          >
            <span className="absolute right-0.5 top-0.5 h-[27px] w-[27px] rounded-full bg-white shadow" />
          </span>
        </div>
        <p className="mb-5 mt-0.5 pr-14 text-[13px] leading-snug text-stone-500">
          Always on. Barista never places an order without your OK.
        </p>
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-col items-stretch">
          <button
            type="button"
            disabled={busy || capCents === null}
            onClick={() => capCents !== null && onAllow(capCents)}
            className="inline-flex h-12 items-center justify-center rounded bg-amber-700 text-[15px] font-medium text-white disabled:opacity-50"
          >
            Allow
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDecline}
            className="inline-flex h-12 items-center justify-center rounded text-[15px] font-medium text-stone-700 disabled:opacity-50"
          >
            Not now
          </button>
          <button
            type="button"
            aria-expanded={how}
            onClick={() => setHow((value) => !value)}
            className="inline-flex min-h-11 items-center justify-center text-[13px] font-medium text-amber-700"
          >
            How this works
          </button>
          {how && (
            <p className="text-[13px] leading-snug text-stone-600">
              Barista only orders after you press Place order. An order over your cap needs a second OK. Payments here are
              test-only: nothing is charged.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
