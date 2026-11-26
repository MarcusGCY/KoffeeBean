"use client";

import { useState } from "react";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import { formatSgd, type ProductCardData } from "@/lib/demo/storefront";
import { YUU_BUY_LABEL, YUU_SIGN_IN_LABEL } from "@/lib/yuu/types";
import { CartIcon, HeartIcon } from "./PelitaIcons";
import { YuuBuyFeedback, type YuuBuyNote } from "./YuuBuyFeedback";

const STOCK_TONE = {
  in: "text-success-text",
  low: "text-warning-text",
  out: "text-ink-3",
} as const;

export function PelitaProductCard({
  product,
  onAdd,
  onBuyYuu,
  yuuSignInHref,
  yuuBusy = false,
  yuuNote = null,
}: {
  product: ProductCardData;
  onAdd: (id: string) => void;
  onBuyYuu?: (id: string) => void;
  /** Set when nobody is signed in. Buy with yuu then sends the shopper to sign in. */
  yuuSignInHref?: string;
  yuuBusy?: boolean;
  yuuNote?: YuuBuyNote | null;
}) {
  const [wished, setWished] = useState(false);
  const out = product.stock.status === "out";

  return (
    <article
      className={`relative flex flex-col rounded-xl bg-surface p-3.5 ${
        product.highlight ? "border-[3px] border-primary shadow-[0_10px_30px_rgba(181,25,91,0.18)]" : "border border-line-2"
      }`}
      data-product-id={product.id}
      data-highlight={product.highlight ? "" : undefined}
    >
      <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-md bg-[#f8f5f2]">
        <div
          className="mb-[22px] h-[98px] w-[98px] [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: PELITA_ART[product.art] }}
        />
        {product.tag && (
          <span
            className={`absolute left-2 top-2 rounded-full px-2.5 py-0.5 text-[16px] font-bold leading-6 text-white ${
              product.tag === "New" ? "bg-primary" : "bg-ink"
            }`}
          >
            {product.tag}
          </span>
        )}
        <button
          type="button"
          aria-label={wished ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
          aria-pressed={wished}
          onClick={() => setWished((w) => !w)}
          className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-full bg-surface text-primary"
        >
          <HeartIcon filled={wished} />
        </button>
        {product.ribbon && (
          <div className="absolute inset-x-0 bottom-0 flex h-8 items-center bg-promo px-3 text-base font-extrabold text-ink">
            {product.ribbon}
          </div>
        )}
      </div>

      <h3 className="mt-2.5 text-lg font-bold leading-[1.25]">{product.name}</h3>
      <p className="text-base text-ink-3">{product.size}</p>

      <div className="mt-1 flex items-end justify-between">
        <p className={`text-price font-extrabold tracking-[-0.5px] ${product.wasPrice === null ? "" : "text-primary"}`}>
          {formatSgd(product.price)}
          {product.wasPrice !== null && (
            <span className="block text-base font-semibold leading-[1.3] tracking-normal text-ink-3 line-through">
              {formatSgd(product.wasPrice)}
            </span>
          )}
        </p>
        <button
          type="button"
          disabled={out}
          aria-label={out ? `${product.name} is out of stock` : `Add ${product.name} to cart`}
          onClick={() => onAdd(product.id)}
          className={`flex size-[50px] flex-none items-center justify-center rounded-md ${
            out ? "cursor-not-allowed bg-line-2 text-ink-3" : "bg-primary text-white"
          }`}
        >
          <CartIcon />
        </button>
      </div>

      {product.memberPrice !== null && (
        <p className="mt-1.5 inline-flex self-start rounded-sm bg-primary-50 px-2.5 text-base font-bold text-primary-dark">
          Member {formatSgd(product.memberPrice)}
        </p>
      )}
      <p className={`mt-1.5 flex items-center gap-2 text-base font-bold ${STOCK_TONE[product.stock.status]}`}>
        <span aria-hidden="true" className="size-2.5 rounded-full bg-current" />
        {product.stock.label}
      </p>
      {yuuSignInHref ? (
        <a
          href={yuuSignInHref}
          className="mt-2 flex h-auto min-h-10 w-full min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 gap-y-0.5 overflow-visible rounded-md bg-primary px-2 py-2 text-center leading-tight text-white"
        >
          <span className="max-w-full text-base font-bold wrap-anywhere">{YUU_SIGN_IN_LABEL}</span>
        </a>
      ) : (
        <button
          type="button"
          disabled={yuuBusy}
          aria-busy={yuuBusy || undefined}
          onClick={() => onBuyYuu?.(product.id)}
          title={YUU_BUY_LABEL}
          className="mt-2 flex h-auto min-h-10 w-full min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 gap-y-0.5 overflow-visible rounded-md bg-primary px-2 py-2 text-center leading-tight text-white disabled:opacity-60"
        >
          <span className="max-w-full text-base font-bold wrap-anywhere">{YUU_BUY_LABEL}</span>
          <span className="max-w-full text-xs font-semibold wrap-anywhere text-primary-50">(simulated)</span>
        </button>
      )}
      <YuuBuyFeedback note={yuuNote ?? null} />
    </article>
  );
}
