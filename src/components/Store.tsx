"use client";

import { useState } from "react";
import products from "@/data/products.json";
import type { CartItem, Product, Shopper } from "@/lib/types";
import { addItem, removeItem, total, getProduct, itemCount } from "@/lib/cart";
import { checkout, type Order } from "@/lib/checkout";
import { productImageUrl } from "@/lib/images";
import { FeedbackWidget } from "./FeedbackWidget";
import { SiteHeader } from "./SiteHeader";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const catalog = products as Product[];

export function Store({ shopper }: { shopper: Shopper }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [code, setCode] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const t = total(cart, code);

  function onCheckout() {
    const placed = checkout(cart, code);
    if (!placed) return;
    setOrder(placed);
    setCart([]);
    setCode("");
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <SiteHeader shopper={shopper} itemCount={itemCount(cart)} />

      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-8 lg:grid-cols-[1fr_340px]">
        <section>
          {(["beans", "merch"] as const).map((cat) => (
            <div key={cat} className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-stone-500">
                {cat === "beans" ? "Coffee beans" : "Merch"}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {catalog.filter((p) => p.category === cat).map((p) => (
                  <article key={p.id} className="flex flex-col overflow-hidden rounded-lg border border-stone-200 bg-white">
                    {/* Native img so a missing bean src shows the browser broken-image icon. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={productImageUrl(p.id)}
                      alt={p.name}
                      width={320}
                      height={200}
                      className="h-44 w-full border-b border-stone-200 bg-stone-100 object-cover"
                    />
                    <div className="flex flex-1 flex-col p-4">
                      <h3 className="font-medium">{p.name}</h3>
                      <p className="mt-1 flex-1 text-sm text-stone-600">{p.blurb}</p>
                      <div className="mt-4 flex items-center justify-between">
                        <span className="font-semibold">{money(p.price)}</span>
                        <button
                          onClick={() => setCart((c) => addItem(c, p.id))}
                          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800"
                        >
                          Add to cart
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </section>

        <aside className="h-fit rounded-lg border border-stone-200 bg-white p-5 lg:sticky lg:top-6">
          <h2 className="mb-3 font-semibold">Your cart</h2>
          {order && (
            <p role="status" className="mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
              Order {order.id} placed. Total {money(order.total)}.
            </p>
          )}
          {cart.length === 0 && <p className="text-sm text-stone-500">Your cart is empty.</p>}
          <ul className="space-y-3">
            {cart.map((i) => (
              <li key={i.productId} className="flex items-center justify-between text-sm">
                <span>{getProduct(i.productId)?.name} × {i.quantity}</span>
                <button onClick={() => setCart((c) => removeItem(c, i.productId))} className="text-stone-500 underline hover:text-stone-900">
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Coupon code"
              aria-label="Coupon code"
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm"
            />
          </div>

          <dl className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{money(t.subtotal)}</dd></div>
            {t.discount > 0 && <div className="flex justify-between text-green-700"><dt>Discount</dt><dd>−{money(t.discount)}</dd></div>}
            <div className="flex justify-between"><dt>Tax (8%)</dt><dd>{money(t.tax)}</dd></div>
            <div className="flex justify-between border-t border-stone-200 pt-2 text-base font-semibold"><dt>Total</dt><dd>{money(t.total)}</dd></div>
          </dl>
          <button
            type="button"
            onClick={onCheckout}
            disabled={itemCount(cart) <= 0}
            className="mt-4 w-full rounded bg-stone-900 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-400"
          >
            Checkout
          </button>
        </aside>
      </main>
      <FeedbackWidget />
    </div>
  );
}
