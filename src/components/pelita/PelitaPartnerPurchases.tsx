"use client";

import { useRef, useState } from "react";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import type { PartnerOffer } from "@/lib/demo/yuu-partners";
import { buyWithYuuRequest } from "@/lib/demo/yuu-client";
import { formatSgd } from "@/lib/demo/storefront";
import { PELITA_SIGN_OUT_HREF } from "@/lib/return-to";
import { YUU_PARTNER_DEFAULT_STORE_ID, YUU_STORES } from "@/lib/yuu/stores";
import { YUU_BUY_LABEL, YUU_PARTNER_HEADING, YUU_SIGN_IN_LABEL, type YuuTierName } from "@/lib/yuu/types";
import type { PelitaAccount } from "./PelitaStorefront";
import { YuuBuyFeedback, type YuuBuyNote } from "./YuuBuyFeedback";

type Balance = { points: number; tier: YuuTierName };
type Note = { sku: string } & YuuBuyNote;

/**
 * Coalition yuu shelf. These buys are recorded on the signed-in shopper, including
 * products Pelita does not stock. Listing still happens only through the two approvals.
 */
export function PelitaPartnerPurchases({
  offers,
  account,
  signInHref,
  wordmark,
  initialBalance = null,
}: {
  offers: PartnerOffer[];
  account: PelitaAccount | null;
  signInHref: string;
  wordmark: string;
  initialBalance?: Balance | null;
}) {
  const [balance, setBalance] = useState<Balance | null>(account ? initialBalance : null);
  const [storeId, setStoreId] = useState(YUU_PARTNER_DEFAULT_STORE_ID);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const lock = useRef(false);

  async function buy(sku: string) {
    if (lock.current) return;
    if (!account) return;
    lock.current = true;
    setBusySku(sku);
    try {
      const result = await buyWithYuuRequest({ sku, qty: 1, channel: "partner", storeId });
      setBalance({ points: result.points, tier: result.tier });
      setNote({ sku, kind: "ok", points: result.pointsEarned });
    } catch (error) {
      setNote({
        sku,
        kind: "error",
        text: error instanceof Error ? error.message : "Could not record the yuu purchase.",
      });
    } finally {
      lock.current = false;
      setBusySku(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-[92px] items-center gap-7 bg-primary px-14 text-white">
        <a href="/pelita" className="text-[30px] font-extrabold leading-none tracking-[-0.6px]">
          {wordmark}
        </a>
        <p className="text-base font-bold">{YUU_PARTNER_HEADING}</p>
        {account && balance && (
          <span data-yuu-tier className="whitespace-nowrap rounded-full bg-surface px-3 py-1 text-base font-bold text-primary-dark">
            {balance.tier} · {balance.points} pts
          </span>
        )}
        <div className="ml-auto">
          {account ? (
            <a href={PELITA_SIGN_OUT_HREF} className="font-bold underline underline-offset-4">
              Sign out
            </a>
          ) : (
            <a href={signInHref} className="font-bold underline underline-offset-4">
              Sign in
            </a>
          )}
        </div>
      </header>
      <main className="flex flex-1 flex-col px-14 pb-10 pt-8">
        <h1 id="yuu-partner-purchases" className="text-h1 font-extrabold tracking-[-1px]">
          {YUU_PARTNER_HEADING}
        </h1>
        <p className="mt-2 max-w-3xl text-lg text-ink-2">
          yuu members also earn points at partner stores. Pelita does not stock every product here. Listing one on the Pelita shelf still takes the two approvals.
        </p>
        <label className="mt-5 flex w-fit items-center gap-3 text-base font-bold">
          Store
          <select
            aria-label="yuu store"
            name="store"
            value={storeId}
            onChange={(event) => setStoreId(event.target.value)}
            className="h-10 rounded-md border border-line-2 bg-surface px-2 text-base font-semibold"
          >
            {YUU_STORES.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </label>
        <div className="mt-6 grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3">
          {offers.map((offer) => (
            <article key={offer.id} data-yuu-partner={offer.id} className="flex flex-col rounded-xl border border-line-2 bg-surface p-3.5">
              <div className="flex h-32 items-center justify-center rounded-md bg-[#f8f5f2]">
                <div
                  className="h-[98px] w-[98px] [&>svg]:h-full [&>svg]:w-full"
                  dangerouslySetInnerHTML={{ __html: PELITA_ART[offer.art] }}
                />
              </div>
              <p className="mt-2.5 text-base font-bold text-ink-3">Partner store</p>
              <h2 className="text-lg font-bold leading-[1.25]">{offer.name}</h2>
              <p className="text-base text-ink-3">{offer.size}</p>
              <p className="mt-1 text-price font-extrabold tracking-[-0.5px]">{formatSgd(offer.price)}</p>
              <p className={`mt-1.5 text-base font-bold ${offer.atPelita ? "text-ink-2" : "text-primary-dark"}`}>
                {offer.atPelita ? "Also at Pelita" : "Not at Pelita"}
              </p>
              {account ? (
                <button
                  type="button"
                  data-yuu-buy={offer.id}
                  disabled={busySku !== null}
                  aria-busy={busySku === offer.id || undefined}
                  onClick={() => void buy(offer.id)}
                  className="mt-2 flex h-auto min-h-10 w-full items-center justify-center rounded-md bg-primary px-2 py-2 text-base font-bold text-white disabled:opacity-60"
                >
                  {YUU_BUY_LABEL}
                </button>
              ) : (
                <a
                  href={signInHref}
                  data-yuu-buy={offer.id}
                  className="mt-2 flex h-auto min-h-10 w-full items-center justify-center rounded-md bg-primary px-2 py-2 text-center text-base font-bold text-white"
                >
                  {YUU_SIGN_IN_LABEL}
                </a>
              )}
              <YuuBuyFeedback note={note?.sku === offer.id ? note : null} />
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
