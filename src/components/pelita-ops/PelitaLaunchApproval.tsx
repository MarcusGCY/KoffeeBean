"use client";

import Link from "next/link";
import { useState } from "react";
import type { ApprovalView, ApproverView, LaunchPhase, RecordedApproval } from "@/lib/demo/approval-view";
import { AUDIT_LINK_LABEL, AUDIT_PATH } from "@/lib/demo/audit-links";
import { STOREFRONT_LINK_LABEL, STOREFRONT_PATH, type PublishedView } from "@/lib/demo/published-view";
import { HumanIcon, SuccessIcon, TickIcon } from "../pelita/PelitaIcons";
import { ConfirmCheckbox } from "./PelitaApprovalModal";

function SourcingLine({ sourcing, className = "" }: { sourcing: RecordedApproval; className?: string }) {
  return (
    <p className={`flex items-center gap-2.5 text-base font-bold text-success-text ${className}`}>
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-success-50">
        <TickIcon />
      </span>
      Sourcing approved by {sourcing.by} · {sourcing.approvalId}
      {sourcing.atLabel ? ` · ${sourcing.atLabel}` : ""}
    </p>
  );
}

/** Screen 05: the second of two human approvals, a different person from the first. */
export function PelitaLaunchApproval({
  data,
  phase,
  actor,
  sourcing,
  launch,
  sentBack,
  published,
  busy,
  error,
  onApprove,
  onSendBack,
}: {
  data: ApprovalView["launch"];
  phase: LaunchPhase;
  actor: ApproverView;
  sourcing: RecordedApproval | null;
  launch: RecordedApproval | null;
  sentBack: { by: string; atLabel: string } | null;
  published?: PublishedView | null;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
  onSendBack: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const samePerson = sourcing !== null && sourcing.approverId === actor.id;
  const allowed = phase === "launch_pending" && actor.slot === data.approver.slot && !samePerson;

  if (phase === "launched" && published) {
    return (
      <section aria-labelledby="launch-outcome" data-launch-published className="mx-auto mt-2 max-w-[1180px]">
        {sourcing && <SourcingLine sourcing={sourcing} className="mb-4" />}
        <div className="rounded-xl border-2 border-[#9ad3b8] bg-surface px-[52px] py-9">
          <div className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-success-text">
            <SuccessIcon size={32} />
            {data.kicker}
          </div>
          <h2 id="launch-outcome" className="mt-2 text-h1 font-extrabold tracking-[-0.6px]">
            {published.title}
          </h2>
          <p className="mt-1 text-lg text-ink-2">{published.line1}</p>
          <p className="text-lg text-ink-2">{published.line2}</p>
          <p className="mt-3 inline-flex rounded-full bg-success-50 px-3.5 py-1 text-base font-bold text-success-text">
            {published.liveIn} · {published.liveInDetail}
          </p>
          <div className="mt-6 flex items-center gap-6">
            <Link
              href={STOREFRONT_PATH}
              className="inline-flex h-14 items-center rounded-md bg-primary px-7 text-lg font-bold text-white"
            >
              {STOREFRONT_LINK_LABEL}
            </Link>
            <Link href={AUDIT_PATH} data-audit-link className="text-lg font-bold text-primary underline underline-offset-4">
              {AUDIT_LINK_LABEL}
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (phase === "sent_back" || phase === "launched") {
    const sent = phase === "sent_back";
    return (
      <section aria-labelledby="launch-outcome" className="mx-auto mt-2 max-w-[1180px]">
        {sourcing && <SourcingLine sourcing={sourcing} className="mb-4" />}
        <div className="rounded-xl border-2 border-line bg-surface px-[52px] py-9">
          <div className="text-base font-extrabold tracking-[0.2px] text-ink-3">{data.kicker}</div>
          <h2 id="launch-outcome" className="mt-2 text-h1 font-extrabold tracking-[-0.6px]">
            {sent
              ? `Sent back by ${sentBack?.by ?? actor.name}${sentBack?.atLabel ? ` · ${sentBack.atLabel}` : ""}`
              : `Listing and promo approved by ${launch?.by ?? actor.name}`}
          </h2>
          <p className="mt-2 text-lg text-ink-2">
            {sent
              ? "The agent will revise the listing and promo. Logged to the audit trail."
              : `${launch?.approvalId ?? ""}${launch?.atLabel ? ` · ${launch.atLabel}` : ""}.`}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="launch-title"
      data-launch-approval
      className="mx-auto mt-1"
    >
      <div className="rounded-xl border-2 border-[#a9bdeb] bg-surface px-10 py-6 shadow-[inset_8px_0_0_var(--color-human)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-human">
            <HumanIcon />
            {data.kicker}
          </div>
          <div className="flex items-center gap-4">
            {sourcing && <SourcingLine sourcing={sourcing} />}
            <span className="rounded-full bg-human-50 px-3.5 py-1 text-base font-bold text-human">{data.chip}</span>
          </div>
        </div>
        <h2 id="launch-title" className="mt-1.5 text-h1 font-extrabold tracking-[-0.6px]">
          {data.title}
        </h2>
        <p className="text-lg text-ink-2">{data.sub}</p>

        <div className="mt-2 grid grid-cols-[1fr_300px] items-start gap-8">
          <dl>
            {data.diff.map((row) => (
              <div key={row.label} className="flex items-center gap-4 border-b border-line-2 py-2">
                <span
                  aria-hidden="true"
                  className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm bg-success-50 font-extrabold text-success-text"
                >
                  +
                </span>
                <dt className="w-[170px] flex-none font-semibold text-ink-3">{row.label}</dt>
                <dd className="text-lg font-bold">
                  {row.old !== undefined && (
                    <>
                      <span data-old-value className="block text-base font-semibold text-ink-3 line-through">
                        {row.old}
                      </span>
                      <span aria-hidden="true">→ </span>
                      <span className="sr-only">changed to </span>
                    </>
                  )}
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex flex-col gap-3">
            {data.stats.map((stat) => (
              <div key={stat.label} className="rounded-lg border border-line-2 bg-[#f8fafc] px-5 py-3">
                <div className="text-[32px] font-extrabold leading-[1.1] tracking-[-1px]">{stat.value}</div>
                <div className="mt-1 text-base font-semibold text-ink-2">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>

        {samePerson && (
          <p role="status" className="mt-4 text-base font-bold text-human">
            {actor.name} already approved sourcing. A different person must approve the listing and promo.
          </p>
        )}
        {!samePerson && actor.slot !== data.approver.slot && (
          <p role="status" className="mt-4 text-base font-bold text-human">
            Waiting for {data.approver.role} approval
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-base font-bold text-danger">
            {error}
          </p>
        )}

        <div className="mt-3 flex items-center justify-between">
          <ConfirmCheckbox label={data.checkboxLabel} checked={checked} disabled={!allowed || busy} onChange={setChecked} />
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onSendBack}
              disabled={!allowed || busy}
              className="h-12 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink disabled:opacity-60"
            >
              {data.sendBackLabel}
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={!allowed || !checked || busy}
              className="h-12 rounded-md bg-human px-7 text-lg font-bold text-white disabled:opacity-50"
            >
              {data.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
