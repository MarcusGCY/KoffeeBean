"use client";

import { useEffect, useState } from "react";
import { sgd } from "@/lib/chat-response";
import { formatCountdown, undoSecondsLeft } from "@/lib/nudge-client";
import type { NextStep, PlacedOrder } from "@/lib/pending-action";
import { Spark } from "./Spark";

type Line = { name: string; qty: number; unitPriceCents: number };

function Lines({ lines, totalCents }: { lines: Line[]; totalCents: number }) {
  return (
    <>
      {lines.map((line) => (
        <div key={line.name} className="flex justify-between text-sm leading-relaxed text-stone-700">
          <span>
            {line.name}
            {line.qty > 1 ? ` × ${line.qty}` : ""}
          </span>
          <span>{sgd(line.unitPriceCents * line.qty)}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between border-t border-stone-200 pt-1.5 text-[15px] font-semibold">
        <span>Total</span>
        <span>{sgd(totalCents)}</span>
      </div>
    </>
  );
}

/** Step after a multi-add Confirm: the cart as Barista will order it, with Place order. */
export function OrderSummaryCard({
  step,
  busy,
  onPlace,
  onDismiss,
}: {
  step: NextStep;
  busy: boolean;
  onPlace: () => void;
  onDismiss: () => void;
}) {
  return (
    <section aria-label="Your order" className="rounded-lg border border-stone-200 bg-white px-3.5 pb-3 pt-2.5">
      <p className="mb-1.5 flex items-baseline justify-between">
        <b className="text-[15px] font-semibold">Your order</b>
        <span className="text-[13px] text-stone-500">
          {step.cart.lines.length} {step.cart.lines.length === 1 ? "item" : "items"}
        </span>
      </p>
      <Lines lines={step.cart.lines} totalCents={step.cart.totalCents} />
      <p className="my-2 text-[13px] leading-snug text-stone-600">
        Test payment only. No card is charged and no card details are collected.
      </p>
      <button
        type="button"
        onClick={onPlace}
        disabled={busy}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded bg-amber-700 text-[15px] font-medium text-white disabled:opacity-50"
      >
        <Spark className="text-white" size={16} />
        Place order · {sgd(step.cart.totalCents)}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy}
        className="mt-1 inline-flex min-h-11 w-full items-center justify-center rounded text-sm text-stone-700 disabled:opacity-50"
      >
        Not now
      </button>
    </section>
  );
}

/** Done card for an order Barista placed, with the 10-minute undo. */
export function PlacedOrderCard({
  order,
  undone,
  busy,
  onUndo,
}: {
  order: PlacedOrder;
  undone: boolean;
  busy: boolean;
  onUndo: () => void;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (undone) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [undone]);
  const left = undoSecondsLeft(order.undoUntil, now ?? new Date(order.createdAt).getTime());
  return (
    <section aria-label="Order placed" className="space-y-2">
      <div className="rounded-lg border border-stone-200 bg-white px-3.5 pb-3 pt-2.5">
        <p className="mb-1.5 flex items-baseline justify-between">
          <b className="text-[15px] font-semibold">Order {order.id}</b>
          {undone ? (
            <span className="inline-flex h-[22px] items-center rounded-full border border-stone-300 bg-white px-2 text-xs font-medium text-stone-600">
              Undone
            </span>
          ) : (
            <span className="inline-flex h-[22px] items-center rounded-full border border-green-100 bg-green-50 px-2 text-xs font-medium text-green-700">
              Done
            </span>
          )}
        </p>
        <Lines lines={order.lines} totalCents={order.totalCents} />
        <p className="mt-2 text-[13px] text-stone-600">Test payment, no card charged.</p>
      </div>
      <p className="flex items-center justify-center gap-1.5 text-xs text-stone-500">
        <Spark size={14} />
        Barista placed this order for you
      </p>
      {undone ? (
        <p className="text-[15px] text-stone-800">Undone. Order {order.id} is cancelled.</p>
      ) : (
        <>
          <p className="text-[15px] text-stone-800">Done. Order {order.id} is placed.</p>
          {left > 0 ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onUndo}
                disabled={busy}
                className="inline-flex min-h-11 items-center text-[15px] font-medium text-amber-700 disabled:opacity-50"
              >
                Undo within 10 min
              </button>
              <span className="text-[13px] text-stone-500">· {formatCountdown(left)} left</span>
            </div>
          ) : (
            <p className="text-[13px] text-stone-500">The 10 minute undo window has closed.</p>
          )}
        </>
      )}
    </section>
  );
}
