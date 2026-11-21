"use client";

import { useState } from "react";
import { MARKETING_TEXT, type MarketingView } from "@/lib/marketing-text";

const FAILED = "That didn't work. Please try again.";

function sent(method: "PUT" | "DELETE", body?: unknown) {
  return fetch("/api/account/marketing", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function MarketingConsent({ initial }: { initial: MarketingView }) {
  const [view, setView] = useState<MarketingView>(initial);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(method: "PUT" | "DELETE") {
    if (busy || (method === "PUT" && !agreed)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sent(method, method === "PUT" ? { consent: true, version: view.version } : undefined);
      if (!res.ok) throw new Error("marketing");
      setView(((await res.json()) as { marketing: MarketingView }).marketing);
      setAgreed(false);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="marketing-title" className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="px-4 py-3.5">
        <h2 id="marketing-title" className="text-[17px] font-semibold tracking-tight">
          Offers and reminders <span className="text-[13px] font-normal text-stone-500">(optional)</span>
        </h2>
        <p className="mt-1 text-[15px] leading-snug text-stone-600">{MARKETING_TEXT}</p>
      </div>
      {view.consented ? (
        <div className="border-t border-stone-200 px-4 py-3">
          <p className="text-[15px] text-stone-800">You opted in on {new Date(view.consentAt ?? "").toLocaleDateString("en-SG")}.</p>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => change("DELETE")}
              disabled={busy}
              className="min-h-11 rounded px-3 text-[15px] font-medium text-[#bf000f] disabled:opacity-50"
            >
              Withdraw
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-stone-200 px-4 py-3">
          {view.needsRenewal && (
            <p className="mb-2 text-[13px] text-stone-600">
              The wording above has changed since you last agreed, so this is off until you agree again.
            </p>
          )}
          <label className="flex items-start gap-3 text-[15px] leading-snug text-stone-800">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-amber-700"
            />
            <span>I agree that BeanBox may use my order habits to send me offers and reminders. I can withdraw this at any time.</span>
          </label>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => change("PUT")}
              disabled={busy || !agreed}
              className="min-h-11 rounded bg-amber-700 px-4 text-[15px] font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="border-t border-stone-200 px-4 py-2 text-[13px] text-[#bf000f]">
          {error}
        </p>
      )}
    </section>
  );
}
