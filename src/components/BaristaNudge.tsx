"use client";

import { sgd } from "@/lib/chat-response";
import type { Nudge, NudgeCard } from "@/lib/nudge";
import { Spark } from "./Spark";

export type NudgeAnswer = "both" | "reorder" | "snooze";

function NudgeProductCard({ card, gramsPerDay }: { card: NudgeCard; gramsPerDay: number | null }) {
  const isNew = card.kind === "new_bean";
  return (
    <article className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={card.image} alt={card.name} className="h-[72px] w-full object-cover" />
      <div className="px-2.5 pb-2.5 pt-2">
        <p className="text-sm font-semibold leading-snug text-stone-900">{card.name}</p>
        <p className="mt-0.5 flex items-baseline justify-between">
          <span className="text-[15px] font-semibold">{sgd(card.priceCents)}</span>
          <span className="text-[13px] text-stone-500">{card.grams} g</span>
        </p>
        <span
          className={`mt-1.5 inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-xs font-medium ${
            isNew ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-700"
          }`}
        >
          {isNew && <Spark size={12} />}
          {card.tag}
        </span>
        <p className="mt-1.5 text-[13px] leading-snug text-stone-600">{card.reason}</p>
        {gramsPerDay !== null && (
          <p className="mt-1 text-xs text-stone-500">Assumes about {gramsPerDay} g of coffee a day.</p>
        )}
      </div>
    </article>
  );
}

/** Barista's proactive reorder card with its stated reasons and the three answer chips. */
export function BaristaNudge({
  nudge,
  answer,
  busy,
  onAnswer,
}: {
  nudge: Nudge;
  answer: NudgeAnswer | null;
  busy: boolean;
  onAnswer: (answer: NudgeAnswer) => void;
}) {
  const chips: { id: NudgeAnswer; label: string; primary?: boolean }[] = nudge.newBean
    ? [
        { id: "both", label: "Yes, both", primary: true },
        { id: "reorder", label: "Just the reorder" },
        { id: "snooze", label: "Not now" },
      ]
    : [
        { id: "reorder", label: "Yes, reorder", primary: true },
        { id: "snooze", label: "Not now" },
      ];
  return (
    <section aria-label="Barista suggestion" className="space-y-2.5">
      <div>
        <p className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-stone-700">
          <Spark size={14} />
          Barista
          {nudge.demo && (
            <span className="ml-auto rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Demo data
            </span>
          )}
        </p>
        <p className="text-[15px] leading-snug text-stone-800">{nudge.message}</p>
      </div>
      <div className={`grid gap-2 ${nudge.newBean ? "grid-cols-2" : "grid-cols-1"}`}>
        <NudgeProductCard card={nudge.reorder} gramsPerDay={nudge.gramsPerDay} />
        {nudge.newBean && <NudgeProductCard card={nudge.newBean} gramsPerDay={null} />}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Answer Barista">
        {chips.map((chip) => {
          const chosen = answer === chip.id;
          const dimmed = answer !== null && !chosen;
          return (
            <button
              key={chip.id}
              type="button"
              disabled={busy || answer !== null}
              aria-pressed={chosen}
              onClick={() => onAnswer(chip.id)}
              className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-sm font-medium whitespace-nowrap ${
                chip.primary
                  ? "border-amber-700 bg-amber-700 text-white"
                  : "border-stone-300 bg-white text-stone-700"
              } ${dimmed ? "opacity-45" : ""} disabled:cursor-default`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
