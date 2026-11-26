"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { readPelitaBag, writePelitaBag, type PelitaBag } from "@/lib/demo/pelita-bag";
import type { ProductDetailModel } from "@/lib/demo/launch-view";
import { formatSgd } from "@/lib/demo/storefront";
import { buyWithYuuRequest } from "@/lib/demo/yuu-client";
import { YUU_BUY_LABEL, YUU_SIGN_IN_LABEL } from "@/lib/yuu/types";
import type { PelitaAccount } from "./PelitaStorefront";
import { PelitaProductImage } from "./PelitaProductImage";
import { CartIcon } from "./PelitaIcons";
import { YuuBuyFeedback, type YuuBuyNote } from "./YuuBuyFeedback";

/**
 * Product detail for one Pelita sku. Add to bag shares the storefront bag.
 * Buy with yuu uses the same simulated purchase as the shelf.
 */
export function PelitaProductDetail({
  product,
  wordmark,
  account = null,
  yuuSignInHref,
}: {
  product: ProductDetailModel;
  wordmark: string;
  account?: PelitaAccount | null;
  yuuSignInHref?: string;
}) {
  const [bag, setBag] = useState<PelitaBag>({});
  const [note, setNote] = useState<YuuBuyNote | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const out = product.stock.status === "out";
  const count = bag[product.sku] ?? 0;
  const total = count * product.payPrice;

  useEffect(() => {
    setBag(readPelitaBag());
  }, []);

  function add() {
    if (out) return;
    setBag((current) => {
      const next = { ...current, [product.sku]: (current[product.sku] ?? 0) + 1 };
      writePelitaBag(next);
      return next;
    });
  }

  async function buyYuu() {
    if (lock.current || !account) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await buyWithYuuRequest({ sku: product.sku, qty: 1 });
      setNote({ kind: "ok", points: result.pointsEarned });
    } catch (error) {
      setNote({ kind: "error", text: error instanceof Error ? error.message : "Could not record the yuu purchase." });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col" data-pdp data-sku={product.sku} data-pdp-state={product.previewBanner ? "preview" : "live"}>
      <header className="flex h-[92px] items-center gap-7 bg-primary px-14 text-white">
        <Link href="/pelita" className="text-[30px] font-extrabold leading-none tracking-[-0.6px]">
          {wordmark}
        </Link>
        <Link href="/pelita" className="text-base font-bold underline underline-offset-4">
          Back to shop
        </Link>
        <div
          className="ml-auto flex h-[52px] items-center gap-2.5 rounded-full bg-surface px-5 font-extrabold text-primary-dark"
          role="status"
          aria-label={`Cart, ${count} ${count === 1 ? "item" : "items"}`}
        >
          <CartIcon />
          <span data-cart-total>{formatSgd(total)}</span>
          {count > 0 && (
            <span className="rounded-full bg-primary px-2 text-base text-white" data-cart-count>
              {count}
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-14 py-8">
        {product.previewBanner && (
          <p data-preview-banner className="mb-6 rounded-md bg-promo px-4 py-3 text-lg font-extrabold text-ink">
            {product.previewBanner}
          </p>
        )}
        <div className="grid items-start gap-10 lg:grid-cols-[360px_1fr]">
          <div className="flex h-[360px] items-center justify-center rounded-xl bg-[#f8f5f2] p-8">
            <PelitaProductImage imageUrl={product.imageUrl} art={product.art} alt={product.title} className="h-full w-full object-contain" />
          </div>
          <div>
            <h1 className="text-h1 font-extrabold tracking-[-1px]">{product.title}</h1>
            {product.size && <p data-size className="mt-1 text-lg text-ink-3">{product.size}</p>}
            {product.category && <p data-category className="mt-1 text-base font-bold text-ink-2">{product.category}</p>}
            {product.supplier && (
              <p data-supplier className="mt-1 text-base text-ink-2">
                Supplier · {product.supplier}
              </p>
            )}
            {product.subtitle && <p data-subtitle className="mt-3 text-lg font-semibold text-ink">{product.subtitle}</p>}
            {product.longCopy && (
              <p data-long-copy className="mt-4 max-w-2xl text-lg text-ink-2">
                {product.longCopy}
              </p>
            )}
            {product.bullets.length > 0 && (
              <ul className="mt-4 list-disc space-y-1 pl-5 text-base font-semibold text-ink">
                {product.bullets.map((bullet) => (
                  <li key={bullet} data-bullet>
                    {bullet}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6">
              {product.wasPriceLabel ? (
                <>
                  <p data-pay-price className="text-price font-extrabold tracking-[-0.5px] text-primary">
                    {product.payPriceLabel}
                  </p>
                  <p data-shelf-price className="text-base font-semibold text-ink-3 line-through">
                    {product.shelfPriceLabel}
                  </p>
                </>
              ) : (
                <p data-pay-price data-shelf-price className="text-price font-extrabold tracking-[-0.5px]">
                  {product.payPriceLabel}
                </p>
              )}
              {product.promo && (
                <p data-promo={product.promo.type} className="mt-3 inline-flex rounded-sm bg-promo px-3 py-1 text-base font-extrabold text-ink">
                  {product.promo.label}
                </p>
              )}
              {product.priceNote && (
                <p data-price-note className="mt-3 max-w-xl text-base text-ink-2">
                  {product.priceNote}
                </p>
              )}
            </div>

            {product.memberOffer && (
              <aside data-member-offer className="mt-5 max-w-xl rounded-xl border border-primary bg-primary-50 px-5 py-4">
                <p className="text-base font-extrabold text-primary-dark">{product.memberOffer.headline}</p>
                {product.memberOffer.memberPriceLabel && (
                  <p data-member-price className="mt-1 text-lg font-extrabold text-primary">
                    Member {product.memberOffer.memberPriceLabel}
                  </p>
                )}
                {product.memberOffer.bonusPoints != null && (
                  <p data-bonus-points className="text-base font-bold text-ink">
                    {product.memberOffer.bonusPoints} bonus points
                  </p>
                )}
                {product.memberOffer.segmentLabel && (
                  <p data-segment className="mt-1 text-base font-bold text-primary-dark">
                    {product.memberOffer.segmentLabel}
                  </p>
                )}
              </aside>
            )}

            {product.stores.length > 0 && (
              <ul className="mt-5 flex flex-wrap gap-2" aria-label="Stores">
                {product.stores.map((store) => (
                  <li key={store} data-store={store} className="rounded-full bg-primary-50 px-3 py-1 text-base font-bold text-primary-dark">
                    {store}
                  </li>
                ))}
              </ul>
            )}

            <p className={`mt-4 text-base font-bold ${out ? "text-ink-3" : "text-success-text"}`}>{product.stock.label}</p>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                data-add-to-bag=""
                disabled={out}
                onClick={add}
                className={`inline-flex h-12 items-center gap-2 rounded-md px-5 text-base font-bold text-white ${
                  out ? "cursor-not-allowed bg-line-2 text-ink-3" : "bg-primary"
                }`}
              >
                <CartIcon />
                Add to bag
              </button>
              {yuuSignInHref ? (
                <a
                  href={yuuSignInHref}
                  className="inline-flex h-12 items-center rounded-md bg-primary px-5 text-base font-bold text-white"
                >
                  {YUU_SIGN_IN_LABEL}
                </a>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  onClick={() => void buyYuu()}
                  className="inline-flex h-12 items-center rounded-md bg-primary px-5 text-base font-bold text-white disabled:opacity-60"
                >
                  {YUU_BUY_LABEL}
                </button>
              )}
            </div>
            <YuuBuyFeedback note={note} />
          </div>
        </div>
      </main>
    </div>
  );
}
