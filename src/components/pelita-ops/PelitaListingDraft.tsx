"use client";

import { useState } from "react";
import type { ListingDraftView } from "@/lib/demo/listing-view";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import { SparkleIcon, SuccessIcon } from "../pelita/PelitaIcons";

export type ListingDraftStatus = "running" | "done" | "failed";

function Skeleton({ className, label }: { className: string; label?: string }) {
  return (
    <>
      <span aria-hidden="true" className={`block animate-pulse rounded-md bg-line-2 ${className}`} />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

function Field({ label, children, emphasis = false }: { label: string; children: React.ReactNode; emphasis?: boolean }) {
  return (
    <div className="border-b border-line-2 py-1.5">
      <dt className="text-base font-semibold text-ink-3">{label}</dt>
      <dd className={`font-bold leading-[1.35] ${emphasis ? "text-[22px]" : "text-lg"}`}>{children}</dd>
    </div>
  );
}

/**
 * Screen 04: the agent's listing, promo and claims draft. It is the agent's work, so it
 * carries the violet stripe and sparkle. The preview on the left is what a shopper would
 * see, marked "Not live yet". Edit changes the description; "Send for approval" is not
 * an approval, so its button is rose and the navy approval buttons stay on screen 05.
 */
export function PelitaListingDraft({
  data,
  status,
  error,
  busy,
  onRetry,
  onEdit,
  onSend,
}: {
  data: ListingDraftView;
  status: ListingDraftStatus;
  error: string | null;
  busy: boolean;
  onRetry: () => void;
  onEdit: (description: string) => Promise<boolean>;
  onSend: () => void;
}) {
  const running = status === "running";
  const done = status === "done";
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(data.description.value);
  const [claimsOpen, setClaimsOpen] = useState(true);
  const { preview, claims, description } = data;

  async function save() {
    if (await onEdit(draftText)) setEditing(false);
  }

  return (
    <section
      aria-labelledby="listing-title"
      aria-busy={running}
      data-listing-draft
      data-listing-status={status}
      className="grid grid-cols-[560px_1fr] gap-7"
    >
      <div className="rounded-xl border border-line-2 bg-surface px-7 py-6">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-extrabold text-ink-2">SHOPPER PREVIEW</h2>
          <span className="rounded-full bg-[#f1f5f9] px-3.5 py-1 text-base font-bold text-ink-2">{preview.badge}</span>
        </div>
        <div className="relative mt-3.5 flex h-60 items-center justify-center overflow-hidden rounded-lg bg-[#f8f5f2]">
          {done ? (
            <>
              <div
                className="mb-6 h-[190px] w-[190px] [&>svg]:h-full [&>svg]:w-full"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: PELITA_ART[preview.art] }}
              />
              {preview.tag && (
                <span className="absolute left-3.5 top-3.5 rounded-full bg-primary px-3.5 py-1 text-base font-bold text-white">{preview.tag}</span>
              )}
              <div className="absolute inset-x-0 bottom-0 flex h-[38px] items-center bg-promo px-4 text-xl font-extrabold text-ink" data-promo-ribbon>
                {preview.ribbon}
              </div>
            </>
          ) : (
            <Skeleton className="h-[150px] w-[150px] rounded-full" />
          )}
        </div>
        {done ? (
          <>
            <p className="mt-3.5 text-[26px] font-extrabold leading-[1.2]">{preview.title}</p>
            <p className="text-ink-3">{preview.category}</p>
            <p className="mt-1.5 flex items-baseline gap-3.5">
              <span className="text-4xl font-extrabold">{preview.price}</span>
              <span className="text-ink-3">{preview.unitPrice}</span>
            </p>
            <button
              type="button"
              disabled
              title="Preview only"
              className="mt-3 h-14 w-full cursor-not-allowed rounded-md bg-primary text-xl font-bold text-white"
            >
              {preview.addLabel}
            </button>
          </>
        ) : (
          <div className="mt-3.5 space-y-2.5">
            <Skeleton className="h-8 w-4/5" />
            <Skeleton className="h-5 w-3/5" />
            <Skeleton className="h-10 w-2/5" />
          </div>
        )}
      </div>

      <div className="rounded-xl border-2 border-[#c9bef5] bg-surface px-[34px] py-4 shadow-[inset_8px_0_0_var(--color-agent)]">
        <div className="flex items-center justify-between">
          <h2 id="listing-title" className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-agent">
            <SparkleIcon />
            {data.kicker}
          </h2>
          {done && data.doneLabel ? (
            <span className="rounded-full bg-agent-50 px-3.5 py-1 text-base font-bold text-agent">{data.doneLabel}</span>
          ) : status === "failed" ? (
            <span className="rounded-full border-2 border-warning-text bg-surface px-3.5 py-0.5 text-base font-bold text-warning-text">
              The claims check did not answer
            </span>
          ) : (
            <span role="status" className="rounded-full bg-agent-50 px-3.5 py-1 text-base font-bold text-agent">
              {data.draftingLabel}
            </span>
          )}
        </div>

        {done ? (
          <>
            <dl className="mt-1">
              <Field label={data.title.label} emphasis>
                {data.title.value}
              </Field>
              <div className="border-b border-line-2 py-1.5">
                <dt className="flex items-center gap-3 text-base font-semibold text-ink-3">
                  {description.label}
                  {description.edited && (
                    <span data-edited-tag className="rounded-sm bg-[#f1f5f9] px-2 text-base font-bold text-ink-2">
                      Edited by {description.edited.by}
                    </span>
                  )}
                </dt>
                <dd className="text-lg font-bold leading-[1.35]">
                  {editing ? (
                    <div>
                      <textarea
                        aria-label={description.label}
                        value={draftText}
                        maxLength={description.max}
                        rows={3}
                        onChange={(e) => setDraftText(e.target.value)}
                        className="mt-1 w-full rounded-md border-2 border-line bg-surface px-3 py-2 text-lg font-semibold text-ink"
                      />
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void save()}
                          disabled={busy || draftText.trim() === ""}
                          className="h-11 rounded-md bg-ink px-5 text-base font-bold text-white disabled:opacity-50"
                        >
                          {data.saveLabel}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDraftText(description.value);
                            setEditing(false);
                          }}
                          disabled={busy}
                          className="h-11 rounded-md border-2 border-line bg-surface px-5 text-base font-bold text-ink disabled:opacity-60"
                        >
                          {data.cancelLabel}
                        </button>
                      </div>
                    </div>
                  ) : (
                    description.value
                  )}
                </dd>
              </div>
              <div className="grid grid-cols-2 gap-x-7">
                {data.fields.map((field) => (
                  <Field key={field.label} label={field.label} emphasis={field.emphasis}>
                    {field.value}
                  </Field>
                ))}
              </div>
            </dl>

            <div className="mt-2.5 rounded-lg border-2 border-[#9ad3b8] bg-success-50 px-[18px] py-2.5" data-claims-check>
              <button
                type="button"
                aria-expanded={claimsOpen}
                onClick={() => setClaimsOpen((open) => !open)}
                className="flex w-full items-center gap-3.5 text-left"
              >
                <SuccessIcon size={30} />
                <span className="leading-[1.35]">
                  <span className="block text-xl font-extrabold text-success-text">{claims.label}</span>
                  <span className="block font-semibold text-ink-2">{claims.detail}</span>
                </span>
              </button>
              {claimsOpen && (
                <div className="mt-2 border-t border-[#9ad3b8] pt-2 text-base font-semibold text-ink-2">
                  {claims.removed.map((item) => (
                    <p key={item.claim}>
                      Removed: “{item.claim}” ({item.reason})
                    </p>
                  ))}
                  <p data-claim-diff className="font-bold text-ink">
                    <span className="line-through">{claims.oldText}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="sr-only"> changed to </span>
                    {claims.newText}
                  </p>
                  <p className="text-ink-3">{claims.disclaimer}</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="mt-4 space-y-3.5">
            <Skeleton className="h-10 w-full" label={data.draftingLabel} />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 text-base font-bold text-danger">
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center justify-end gap-4">
          {status === "failed" ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className="h-14 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink disabled:opacity-60"
            >
              Retry
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setDraftText(description.value);
                  setEditing(true);
                }}
                disabled={!done || !data.canEdit || busy || editing}
                className="h-14 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink disabled:opacity-50"
              >
                {data.editLabel}
              </button>
              <button
                type="button"
                onClick={onSend}
                disabled={!done || !data.canSend || busy || editing}
                className="h-14 rounded-md bg-primary px-7 text-lg font-bold text-white disabled:opacity-50"
              >
                {data.sendLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
