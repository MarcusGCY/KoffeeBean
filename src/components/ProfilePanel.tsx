"use client";

import Link from "next/link";
import { useState } from "react";
import { MAX_CADENCE_DAYS } from "@/lib/barista-profile-limits";
import { cadenceLabel, dueLabel, pace, roastLabel, ROAST_LABEL, type ProfileView } from "@/lib/profile-text";
import { ROASTS, type Roast } from "@/lib/types";

const FAILED = "That didn't work. Please try again.";

async function send(method: "PATCH" | "DELETE", body?: unknown): Promise<ProfileView> {
  const res = await fetch("/api/account/profile", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error("profile");
  return ((await res.json()) as { profile: ProfileView }).profile;
}

function Row({ label, value, edited }: { label: string; value: React.ReactNode; edited?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-stone-200 px-4 py-3 first:border-t-0">
      <dt className="text-[15px] text-stone-600">{label}</dt>
      <dd className="text-right text-[15px] font-medium text-stone-900">
        {value}
        {edited && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">You set this</span>}
      </dd>
    </div>
  );
}

function Editor({ view, busy, onSave, onCancel }: { view: ProfileView; busy: boolean; onSave: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const [roast, setRoast] = useState<string>(view.preferredRoast ?? "");
  const [cadence, setCadence] = useState<string>(view.cadenceDays?.toString() ?? "");
  const [grams, setGrams] = useState<string>(view.gramsPerDay?.toString() ?? "");
  const cadenceOk = cadence === "" || (Number.isInteger(Number(cadence)) && Number(cadence) >= 1 && Number(cadence) <= MAX_CADENCE_DAYS);
  const gramsOk = grams === "" || (Number.isInteger(Number(grams)) && Number(grams) >= 1 && Number(grams) <= 100);
  const body: Record<string, unknown> = {};
  const nextRoast = roast === "" ? null : roast;
  if (nextRoast !== view.preferredRoast) body.preferredRoast = nextRoast;
  const nextCadence = cadence === "" ? null : Number(cadence);
  if (nextCadence !== view.cadenceDays) body.cadenceDays = nextCadence;
  if (grams !== "" && Number(grams) !== view.gramsPerDay) body.gramsPerDay = Number(grams);
  const changed = Object.keys(body).length > 0;
  const field = "h-11 w-full rounded border border-stone-300 bg-white px-3 text-[15px]";
  return (
    <div className="border-t border-stone-200 px-4 py-3">
      <label htmlFor="roast" className="mb-1 block text-[13px] font-medium text-stone-600">
        Roast you like
      </label>
      <select id="roast" value={roast} onChange={(event) => setRoast(event.target.value)} className={field}>
        <option value="">Not sure yet</option>
        {ROASTS.map((value: Roast) => (
          <option key={value} value={value}>
            {ROAST_LABEL[value]}
          </option>
        ))}
      </select>
      <label htmlFor="cadence" className="mb-1 mt-3 block text-[13px] font-medium text-stone-600">
        Days between bean orders
      </label>
      <input id="cadence" inputMode="numeric" value={cadence} onChange={(event) => setCadence(event.target.value.replace(/\D/g, ""))} placeholder="Not sure yet" className={field} />
      <label htmlFor="grams" className="mb-1 mt-3 block text-[13px] font-medium text-stone-600">
        Grams of coffee a day
      </label>
      <input id="grams" inputMode="numeric" value={grams} onChange={(event) => setGrams(event.target.value.replace(/\D/g, ""))} className={field} />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-stone-700">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(body)}
          disabled={busy || !changed || !cadenceOk || !gramsOk}
          className="min-h-11 rounded bg-amber-700 px-4 text-[15px] font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function ProfilePanel({ initial }: { initial: ProfileView }) {
  const [view, setView] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const off = view.personalization === "off";

  async function run(task: () => Promise<ProfileView>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setView(await task());
      setEditing(false);
      setConfirmReset(false);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section aria-labelledby="personalization-title" className="mb-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id="personalization-title" className="text-[17px] font-semibold tracking-tight">
              Personalization
            </h2>
            <p className="mt-0.5 text-[15px] leading-snug text-stone-600">
              {off
                ? "Off. Barista is not learning from your orders or using a profile."
                : "On. Barista uses your order habits, never your name, email or postcode, to tailor suggestions."}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!off}
            aria-label="Personalization"
            disabled={busy}
            onClick={() => run(() => send("PATCH", { personalization: off ? "on" : "off" }))}
            className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-50 ${off ? "bg-stone-300" : "bg-amber-700"}`}
          >
            <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${off ? "left-1" : "left-7"}`} />
          </button>
        </div>
      </section>

      {!off && (
        <section aria-labelledby="knows-title" className="mb-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
          <div className="px-4 py-3.5">
            <h2 id="knows-title" className="text-[17px] font-semibold tracking-tight">
              What Barista knows
            </h2>
            {!view.hasData && <p className="mt-1 text-[15px] leading-snug text-stone-600">Nothing yet. Barista learns from the orders you place.</p>}
          </div>
          {view.hasData && (
            <dl className="border-t border-stone-200">
              <Row label="Roast you like" value={roastLabel(view.preferredRoast)} edited={view.edited.includes("preferredRoast")} />
              <Row label="How often you order beans" value={cadenceLabel(view.cadenceDays)} edited={view.edited.includes("cadenceDays")} />
              <Row label="How fast you go through coffee" value={pace(view.gramsPerDay)} edited={view.edited.includes("gramsPerDay")} />
              <Row label="Next reorder around" value={dueLabel(view.nextDue)} />
              <Row label="Your most bought" value={view.topProducts.length ? view.topProducts.map((item) => item.name).join(", ") : "Nothing yet"} />
              <Row label="A bean you might like" value={view.nextBean?.name ?? "Nothing yet"} />
            </dl>
          )}
          <Row
            label="Your area"
            value={
              <>
                {view.district ? `District ${view.district}` : "Not shared"}{" "}
                <Link href="/account/location" className="text-[15px] font-medium text-amber-800 underline">
                  {view.district ? "Manage" : "Add"}
                </Link>
              </>
            }
          />
          {editing ? (
            <Editor view={view} busy={busy} onSave={(body) => run(() => send("PATCH", body))} onCancel={() => setEditing(false)} />
          ) : (
            <div className="flex justify-end gap-1 border-t border-stone-200 px-2">
              {view.hasData && (
                <button type="button" onClick={() => setEditing(true)} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-amber-800 disabled:opacity-50">
                  Edit
                </button>
              )}
              {confirmReset ? (
                <>
                  <button type="button" onClick={() => setConfirmReset(false)} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-stone-700">
                    Keep
                  </button>
                  <button type="button" onClick={() => run(() => send("DELETE"))} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-[#bf000f] disabled:opacity-50">
                    Confirm reset
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmReset(true)} disabled={busy} className="min-h-11 rounded px-3 text-[15px] font-medium text-[#bf000f] disabled:opacity-50">
                  Reset
                </button>
              )}
            </div>
          )}
          {confirmReset && (
            <p className="border-t border-stone-200 px-4 py-2 text-[13px] text-stone-500">
              Reset clears anything you corrected and relearns from your orders. To stop Barista using a profile, turn personalization off.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="px-1 py-2 text-[13px] text-[#bf000f]">
          {error}
        </p>
      )}
    </>
  );
}
