"use client";

import { useMemo, useState } from "react";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import { formatSgd, searchCatalogue, type StorefrontView } from "@/lib/demo/storefront";
import { CartIcon, PelitaMarkOnRose, SearchIcon, SuccessIcon, UserIcon } from "./PelitaIcons";
import { PelitaProductCard } from "./PelitaProductCard";

type Browse = { kind: "deals" } | { kind: "all" } | { kind: "category"; name: string } | { kind: "launched" };

function Art({ name, className }: { name: keyof typeof PELITA_ART; className: string }) {
  return <div className={`${className} [&>svg]:h-full [&>svg]:w-full`} dangerouslySetInnerHTML={{ __html: PELITA_ART[name] }} />;
}

function Dotted({ items }: { items: string[] }) {
  return (
    <div className="flex items-center">
      {items.map((item, i) => (
        <span key={item} className="flex items-center">
          {i > 0 && (
            <span aria-hidden="true" className="mx-3.5 text-primary-50/70">
              ·
            </span>
          )}
          {item}
        </span>
      ))}
    </div>
  );
}

function resultsLabel(count: number): string {
  return `${count} ${count === 1 ? "result" : "results"}`;
}

/**
 * Screen 00: the storefront before the demo story starts. Once the launched product is
 * listed (`view.published`), it opens on screen 06 instead: the product's category with
 * the new card first, the "live" toast and the search proof. The cart lives in this
 * component's state only.
 */
export function PelitaStorefront({ view }: { view: StorefrontView }) {
  const published = view.published;
  const [browse, setBrowse] = useState<Browse>(published ? { kind: "launched" } : { kind: "deals" });
  const [chip, setChip] = useState(0);
  const [toastOpen, setToastOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});

  const byId = useMemo(() => new Map(view.catalogue.map((p) => [p.id, p])), [view.catalogue]);
  const cartCount = Object.values(cart).reduce((sum, n) => sum + n, 0);
  const cartTotal = Object.entries(cart).reduce((sum, [id, qty]) => sum + (byId.get(id)?.price ?? 0) * qty, 0);
  const addToCart = (id: string) => setCart((c) => ({ ...c, [id]: (c[id] ?? 0) + 1 }));

  const showDeals = () => {
    setQuery("");
    setBrowse({ kind: "deals" });
  };

  const searching = query.trim() !== "";
  const launchedView = published !== null && !searching && browse.kind === "launched";
  let heading = "Deals of the week";
  let products = view.deals.products;
  if (searching) {
    heading = "Search results";
    products = searchCatalogue(view.catalogue, query);
  } else if (published && browse.kind === "launched") {
    const picked = published.chips[chip];
    heading = published.category;
    products =
      picked?.kind === "group"
        ? view.catalogue.filter((p) => p.subcategory === picked.label)
        : published.productIds.flatMap((id) => view.catalogue.filter((p) => p.id === id));
  } else if (browse.kind === "all") {
    heading = "All products";
    products = view.catalogue;
  } else if (browse.kind === "category") {
    heading = browse.name;
    products = view.catalogue.filter((p) => p.category === browse.name);
  }
  const showCountdown = !searching && browse.kind === "deals";
  const showPromoRow = !launchedView;

  const navPill = "rounded-full px-3 py-2 text-base font-bold text-ink";

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-10 items-center justify-between bg-primary-dark px-14 text-base font-semibold text-white">
        <Dotted items={view.utilityBar.left} />
        <Dotted items={view.utilityBar.right} />
      </div>

      <header className="flex h-[92px] items-center gap-7 bg-primary px-14">
        <div className="flex items-center gap-3">
          <PelitaMarkOnRose />
          <div>
            <div className="text-[30px] font-extrabold leading-none tracking-[-0.6px] text-white">{view.brand.wordmark}</div>
            <div className="mt-[5px] text-[12px] font-extrabold leading-none tracking-[2.6px] text-[#ffe7a3]">
              {view.brand.wordmarkSub}
            </div>
          </div>
        </div>
        <form role="search" onSubmit={(e) => e.preventDefault()} className="flex h-14 flex-1 items-center gap-3.5 rounded-full bg-surface px-6 text-lg text-ink-3">
          <SearchIcon />
          <input
            type="search"
            aria-label="Search products"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={view.searchPlaceholder}
            className="h-full flex-1 bg-transparent font-semibold text-ink outline-none placeholder:font-medium placeholder:text-ink-3"
          />
        </form>
        <div className="flex items-center gap-2 font-bold text-white">
          <UserIcon />
          Sign in
        </div>
        <div
          className="flex h-[52px] items-center gap-2.5 rounded-full bg-surface px-5 font-extrabold text-primary-dark"
          role="status"
          aria-label={`Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}, ${formatSgd(cartTotal)}`}
        >
          <CartIcon />
          <span data-cart-total>{formatSgd(cartTotal)}</span>
          {cartCount > 0 && (
            <span className="rounded-full bg-primary px-2 text-base text-white" data-cart-count>
              {cartCount}
            </span>
          )}
        </div>
        <span
          data-demo-tag
          className="inline-flex items-center whitespace-nowrap rounded-sm border-2 border-dashed border-ink bg-surface px-3 py-[3px] text-base font-extrabold tracking-[0.6px] text-ink"
        >
          {view.demoTag}
        </span>
      </header>

      <nav aria-label="Categories" className="flex h-[60px] items-center gap-1.5 border-b border-line-2 bg-surface px-14">
        <button
          type="button"
          onClick={showDeals}
          className="rounded-full bg-promo px-[18px] py-2 text-base font-bold text-ink"
        >
          Offers
        </button>
        {view.categories.map((name) => {
          const isPublishedCategory = published !== null && name === published.category;
          const active =
            !searching && ((browse.kind === "category" && browse.name === name) || (browse.kind === "launched" && isPublishedCategory));
          return (
            <button
              key={name}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                setQuery("");
                setChip(0);
                setBrowse(isPublishedCategory ? { kind: "launched" } : { kind: "category", name });
              }}
              className={`${navPill} ${active ? "bg-primary-50 text-primary-dark" : ""}`}
            >
              {name}
            </button>
          );
        })}
      </nav>

      <main className="flex flex-1 flex-col px-14 pb-10 pt-5">
        {showPromoRow && (
        <div className="grid grid-cols-[1fr_400px] gap-5">
          <section
            aria-label="Promotion"
            className="flex h-[200px] items-center gap-7 overflow-hidden rounded-xl bg-linear-to-r from-primary-dark to-primary to-70% px-11 text-white"
          >
            <div className="flex-1">
              <p className="text-base font-bold text-[#ffe7a3]">{view.hero.kicker}</p>
              <h2 className="mt-1 max-w-[340px] text-display font-extrabold tracking-[-1px]">{view.hero.headline}</h2>
              <button
                type="button"
                onClick={showDeals}
                className="mt-3 inline-flex h-12 items-center rounded-md bg-surface px-7 text-base font-bold text-primary-dark"
              >
                {view.hero.cta}
              </button>
            </div>
            <div className="flex items-end gap-1" aria-hidden="true">
              {view.hero.art.map((name, i) => (
                <div
                  key={name}
                  className={`flex items-center justify-center rounded-full bg-surface ${i === 1 ? "size-[136px]" : "size-[110px]"}`}
                >
                  <Art name={name} className={i === 1 ? "size-[104px]" : "size-[84px]"} />
                </div>
              ))}
            </div>
          </section>
          <section aria-label="Members" className="flex h-[200px] items-center gap-3 overflow-hidden rounded-xl bg-promo px-7 text-ink">
            <div className="flex-1">
              <p className="text-base font-extrabold">{view.sideBanner.kicker}</p>
              <h2 className="text-h2 font-extrabold tracking-[-0.5px]">{view.sideBanner.headline}</h2>
              <button type="button" className="mt-2 text-base font-bold underline">
                {view.sideBanner.cta}
              </button>
            </div>
            <div className="flex size-[110px] flex-none items-center justify-center rounded-full bg-surface" aria-hidden="true">
              <Art name={view.sideBanner.art} className="size-[86px]" />
            </div>
          </section>
        </div>
        )}

        <section className={showPromoRow ? "mt-[22px]" : "mt-0.5"} aria-labelledby="pelita-products-heading">
          {launchedView && published && (
            <p className="text-base font-semibold text-ink-3" data-breadcrumb>
              {published.breadcrumb.join(" › ")}
            </p>
          )}
          <div className="flex items-center gap-4">
            <h2
              id="pelita-products-heading"
              className={launchedView ? "text-h1 font-extrabold tracking-[-1px]" : "text-h2 font-extrabold tracking-[-0.3px]"}
            >
              {heading}
            </h2>
            {showCountdown && view.deals.countdown.parts.length > 0 && (
              <p className="flex items-center gap-1.5 text-base font-bold text-ink-2">
                {view.deals.countdown.prefix}
                {view.deals.countdown.parts.map((part) => (
                  <b key={part} className="rounded-sm bg-ink px-2.5 py-0.5 tabular-nums text-white">
                    {part}
                  </b>
                ))}
              </p>
            )}
            {browse.kind === "deals" && !searching && (
              <button
                type="button"
                onClick={() => setBrowse({ kind: "all" })}
                className="ml-auto text-base font-bold text-primary-dark"
              >
                See all
              </button>
            )}
          </div>
          {launchedView && published && (
            <div role="group" aria-label="Filter by group" className="mt-2.5 flex items-center gap-2.5">
              {published.chips.map((item, i) => {
                const label = `${item.label}${item.count === null ? "" : ` · ${item.count}`}`;
                const base = "rounded-full px-[18px] py-1.5 text-base font-bold";
                if (item.kind === "static") {
                  return (
                    <span key={item.label} className={`${base} border-2 border-line bg-surface text-ink`}>
                      {label}
                    </span>
                  );
                }
                return (
                  <button
                    key={item.label}
                    type="button"
                    aria-pressed={chip === i}
                    onClick={() => setChip(i)}
                    className={`${base} ${chip === i ? "bg-ink text-white" : "border-2 border-line bg-surface text-ink"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {products.length === 0 ? (
            <p className="mt-6 rounded-xl border border-line-2 bg-surface p-6 text-lg text-ink-2" role="status">
              No results for “{query.trim()}”.
            </p>
          ) : (
            <div className={`${launchedView ? "mt-[18px]" : "mt-3.5"} grid grid-cols-5 gap-[22px]`}>
              {products.map((product) => (
                <PelitaProductCard key={product.id} product={product} onAdd={addToCart} />
              ))}
            </div>
          )}
          {launchedView && published && (
            <div
              data-search-proof
              className="mt-[18px] flex items-center gap-5 rounded-xl border border-line-2 bg-surface px-6 py-4"
            >
              <button
                type="button"
                onClick={() => setQuery(published.proof.query)}
                className="flex h-[52px] w-[480px] flex-none items-center gap-3.5 rounded-full border-2 border-line bg-surface px-6 text-left text-lg font-semibold text-ink"
              >
                <SearchIcon />
                {published.proof.query}
              </button>
              <p className="text-[22px] font-bold">
                Before: <span className="text-danger">{resultsLabel(published.proof.before)}</span>
                <span aria-hidden="true"> &nbsp;→&nbsp; </span>
                <span className="sr-only"> then </span>
                Now:{" "}
                <span className="text-success-text">
                  {resultsLabel(published.proof.after)}
                  {published.proof.afterLabel ? `, ${published.proof.afterLabel.toLowerCase()}` : ""}
                </span>
              </p>
            </div>
          )}
        </section>
      </main>

      {published?.toast && toastOpen && (
        <aside
          role="status"
          data-live-toast
          className="fixed right-14 top-[206px] z-10 flex w-[540px] gap-4 rounded-xl border-2 border-[#7cc4a4] bg-surface px-6 py-5 shadow-[0_18px_50px_rgba(15,23,42,0.2)]"
        >
          <SuccessIcon size={40} />
          <div className="flex-1">
            <p className="text-[22px] font-extrabold leading-tight">{published.toast.title}</p>
            <p className="text-ink-2">{published.toast.line1}</p>
            <p className="text-ink-2">{published.toast.line2}</p>
            <p className="mt-1 text-base font-bold text-success-text">
              {published.toast.liveIn} · {published.toast.liveInDetail}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setToastOpen(false)}
            aria-label="Dismiss"
            className="h-8 self-start rounded-sm px-2 text-lg font-bold text-ink-3"
          >
            ×
          </button>
        </aside>
      )}
    </div>
  );
}
