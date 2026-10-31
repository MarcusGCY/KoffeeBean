"use client";

import { useEffect, useState } from "react";
import products from "@/data/products.json";
import type { CartItem, Product, Shopper } from "@/lib/types";
import { getProduct, itemCount } from "@/lib/cart";
import { productImageUrl } from "@/lib/images";
import type { CartSnapshot, OrderSummary } from "@/lib/store-types";
import { FeedbackWidget } from "./FeedbackWidget";
import { SiteHeader } from "./SiteHeader";
import { SupportChat } from "./SupportChat";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const catalog = products as Product[];

const emptyCart: CartSnapshot = {
  items: [],
  coupon: null,
  subtotalCents: 0,
  discountCents: 0,
  taxCents: 0,
  totalCents: 0,
};

export function Store({ shopper, demoHref }: { shopper: Shopper; demoHref?: string }) {
  const [cart, setCart] = useState<CartSnapshot>(emptyCart);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [code, setCode] = useState("");
  const [placed, setPlaced] = useState<{ id: string; totalCents: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cartRes, orderRes] = await Promise.all([fetch("/api/cart"), fetch("/api/orders")]);
        if (cartRes.status === 503 || orderRes.status === 503) {
          if (!cancelled) setUnavailable(true);
          return;
        }
        const cartBody = (await cartRes.json().catch(() => null)) as CartSnapshot | null;
        const orderBody = (await orderRes.json().catch(() => null)) as { orders?: OrderSummary[] } | null;
        if (!cartRes.ok || !cartBody || !orderRes.ok || !orderBody?.orders) {
          if (!cancelled) setUnavailable(true);
          return;
        }
        if (cancelled) return;
        setCart(cartBody);
        setCode(cartBody.coupon ?? "");
        setOrders(orderBody.orders);
        setReady(true);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(method: string, path: string, body?: unknown): Promise<unknown | null> {
    setPending(true);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 503 || payload?.error === "store_unavailable") {
        setUnavailable(true);
        return null;
      }
      if (!res.ok) {
        setNotice(messageFor(payload?.error));
        return null;
      }
      return payload;
    } catch {
      setUnavailable(true);
      return null;
    } finally {
      setPending(false);
    }
  }

  function applyCart(next: CartSnapshot) {
    setCart(next);
    setCode(next.coupon ?? "");
  }

  async function syncCoupon(): Promise<boolean> {
    const trimmed = code.trim();
    const current = cart.coupon ?? "";
    if (trimmed.toUpperCase() === current.toUpperCase() || (!trimmed && !current)) return true;
    if (!trimmed) {
      const next = (await send("DELETE", "/api/cart/coupon", {})) as CartSnapshot | null;
      if (!next) return false;
      applyCart(next);
      return true;
    }
    const next = (await send("POST", "/api/cart/coupon", { code: trimmed })) as CartSnapshot | null;
    if (!next) return false;
    applyCart(next);
    return true;
  }

  async function onAdd(productId: string) {
    const next = (await send("POST", "/api/cart/items", { productId })) as CartSnapshot | null;
    if (next) applyCart(next);
  }

  async function onRemove(productId: string) {
    const next = (await send("DELETE", "/api/cart/items", { productId })) as CartSnapshot | null;
    if (next) applyCart(next);
  }

  async function onCheckout() {
    if (!(await syncCoupon())) return;
    const order = (await send("POST", "/api/orders", {})) as OrderSummary | null;
    if (!order) return;
    setPlaced({ id: order.id, totalCents: order.totalCents });
    setCart(emptyCart);
    setCode("");
    const listed = (await send("GET", "/api/orders")) as { orders: OrderSummary[] } | null;
    if (listed?.orders) setOrders(listed.orders);
  }

  async function onCancel(id: string) {
    const order = (await send("POST", `/api/orders/${id}/cancel`, {})) as OrderSummary | null;
    if (order) {
      setOrders((current) => current.map((item) => (item.id === order.id ? order : item)));
      return;
    }
    try {
      const res = await fetch("/api/orders");
      const body = (await res.json().catch(() => null)) as { orders?: OrderSummary[] } | null;
      if (body?.orders) setOrders(body.orders);
    } catch {
      // Keep the cancel error on screen.
    }
  }

  const lines: CartItem[] = cart.items.map((item) => ({ productId: item.productId, quantity: item.qty }));

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <SiteHeader shopper={shopper} itemCount={itemCount(lines)} demoHref={demoHref} />

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
                          type="button"
                          onClick={() => onAdd(p.id)}
                          disabled={pending || unavailable}
                          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-stone-400"
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
          {unavailable && (
            <p role="status" className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              The store is unavailable.
            </p>
          )}
          {placed && (
            <p role="status" className="mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
              Order {placed.id} placed. Total {money(placed.totalCents)}.
            </p>
          )}
          {notice && <p className="mb-3 text-sm text-red-700">{notice}</p>}
          {!ready && !unavailable && <p className="text-sm text-stone-500">Loading your cart…</p>}
          {ready && cart.items.length === 0 && <p className="text-sm text-stone-500">Your cart is empty.</p>}
          <ul className="space-y-3">
            {cart.items.map((item) => (
              <li key={item.productId} className="flex items-center justify-between text-sm">
                <span>
                  {getProduct(item.productId)?.name ?? item.productId} × {item.qty}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(item.productId)}
                  disabled={pending || unavailable}
                  className="text-stone-500 underline hover:text-stone-900 disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void syncCoupon();
                }
              }}
              placeholder="Coupon code"
              aria-label="Coupon code"
              disabled={pending || unavailable}
              className="w-full rounded border border-stone-300 px-2 py-1.5 text-sm disabled:opacity-50"
            />
          </div>

          <dl className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{money(cart.subtotalCents)}</dd></div>
            {cart.discountCents > 0 && (
              <div className="flex justify-between text-green-700"><dt>Discount</dt><dd>−{money(cart.discountCents)}</dd></div>
            )}
            <div className="flex justify-between"><dt>Tax (8%)</dt><dd>{money(cart.taxCents)}</dd></div>
            <div className="flex justify-between border-t border-stone-200 pt-2 text-base font-semibold">
              <dt>Total</dt><dd>{money(cart.totalCents)}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => void onCheckout()}
            disabled={pending || unavailable || itemCount(lines) <= 0}
            className="mt-4 w-full rounded bg-stone-900 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-400"
          >
            Checkout
          </button>

          <h2 className="mb-2 mt-6 font-semibold">My orders</h2>
          {orders.length === 0 && <p className="text-sm text-stone-500">No orders yet.</p>}
          <ul className="space-y-3">
            {orders.map((order) => (
              <li key={order.id} className="text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{order.id}</span>
                  <span>{money(order.totalCents)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-stone-600">
                  <span>{formatWhen(order.createdAt)}</span>
                  <span className="capitalize">{order.status}</span>
                </div>
                {order.cancellable && (
                  <button
                    type="button"
                    onClick={() => void onCancel(order.id)}
                    disabled={pending || unavailable}
                    className="mt-1 text-stone-500 underline hover:text-stone-900 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>
      </main>
      <FeedbackWidget />
      <SupportChat />
    </div>
  );
}

function messageFor(error: string | undefined): string {
  if (error === "invalid_coupon") return "That coupon code is not valid.";
  if (error === "empty_cart") return "Your cart is empty.";
  if (error === "not_cancellable") return "This order can no longer be cancelled.";
  if (error === "qty_limit") return "You can only add 99 of one item.";
  return "Something went wrong.";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
