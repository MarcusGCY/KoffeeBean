"use client";

import { useState } from "react";
import { LOCATION_PURPOSE_TEXT, districtOf, parsePostcode, type LocationConsent as Location } from "@/lib/location-text";

const FAILED = "That didn't work. Please try again.";

function sent(method: "PUT" | "DELETE", body?: unknown) {
  return fetch("/api/account/location", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export function LocationConsent({ initial }: { initial: Location | null }) {
  const [location, setLocation] = useState<Location | null>(initial);
  const [postcode, setPostcode] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = parsePostcode(postcode) !== null;

  async function save() {
    if (!agreed || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sent("PUT", { postcode: postcode.trim(), consent: true });
      if (!res.ok) throw new Error("save");
      setLocation(((await res.json()) as { location: Location }).location);
      setPostcode("");
      setAgreed(false);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sent("DELETE");
      if (!res.ok) throw new Error("withdraw");
      setLocation(null);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="location-title" className="mb-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="px-4 py-3.5">
        <h2 id="location-title" className="text-[17px] font-semibold tracking-tight">
          Your area <span className="text-[13px] font-normal text-stone-500">(optional)</span>
        </h2>
        <p className="mt-1 text-[15px] leading-snug text-stone-600">{LOCATION_PURPOSE_TEXT}</p>
      </div>
      {location ? (
        <div className="border-t border-stone-200 px-4 py-3">
          <p className="text-[15px] text-stone-800">
            Saved postcode <span className="font-semibold">{location.postcode}</span> (district{" "}
            <span className="font-semibold">{location.district}</span>).
          </p>
          <p className="mt-1 text-[13px] text-stone-500">Allowed on {new Date(location.consentAt).toLocaleDateString("en-SG")}.</p>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={withdraw}
              disabled={busy}
              className="min-h-11 rounded px-3 text-[15px] font-medium text-[#bf000f] disabled:opacity-50"
            >
              Withdraw and clear
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-stone-200 px-4 py-3">
          <label htmlFor="postcode" className="mb-1 block text-[13px] font-medium text-stone-600">
            Singapore postcode
          </label>
          <input
            id="postcode"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={postcode}
            onChange={(event) => setPostcode(event.target.value.replace(/\D/g, ""))}
            placeholder="6 digits"
            className="h-11 w-full rounded border border-stone-300 px-3 text-[15px]"
          />
          {valid && <p className="mt-1 text-[13px] text-stone-500">Only district {districtOf(postcode)} is used beyond your account.</p>}
          <label className="mt-3 flex items-start gap-3 text-[15px] leading-snug text-stone-800">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-amber-700"
            />
            <span>I agree that BeanBox may use my postal district for the purpose above. I can withdraw this at any time.</span>
          </label>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={save}
              disabled={busy || !agreed || !valid}
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
