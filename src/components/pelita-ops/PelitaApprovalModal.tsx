"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ApprovalView, ApproverView } from "@/lib/demo/approval-view";
import { HumanIcon } from "../pelita/PelitaIcons";

export function ConfirmCheckbox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-3.5 text-lg font-semibold ${disabled ? "text-ink-3" : "text-ink"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-7 w-7 flex-none accent-human"
      />
      {label}
    </label>
  );
}

export function Avatar({ person, size = 48 }: { person: ApproverView; size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex flex-none items-center justify-center rounded-full bg-human text-[17px] font-extrabold text-white"
    >
      {person.initials}
    </span>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Screen 02: the first of two human approvals, a modal over the demand-gap proposal. */
export function PelitaApprovalModal({
  data,
  actor,
  busy,
  error,
  onCancel,
  onApprove,
}: {
  data: ApprovalView["sourcing"];
  actor: ApproverView;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const allowed = actor.slot === data.approver.slot;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div data-approval-modal className="fixed inset-0 z-50 flex items-center justify-center bg-ink/55">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[780px] max-w-[calc(100vw-48px)] rounded-2xl bg-surface px-10 py-9 shadow-[0_30px_80px_rgba(0,0,0,0.35)]"
      >
        <div className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-human">
          <HumanIcon />
          {data.kicker}
        </div>
        <h2 id={titleId} className="mt-3 text-h1 font-extrabold tracking-[-0.6px]">
          {data.title}
        </h2>
        <p className="mt-1.5 text-lg text-ink-2">{data.sub}</p>

        <dl className="mt-[22px] grid grid-cols-[auto_1fr] gap-x-7 gap-y-3.5 rounded-lg border border-line-2 bg-[#f8fafc] px-[26px] py-[22px] text-lg">
          {data.summary.map((row) => (
            <div key={row.label} className="contents">
              <dt className="font-semibold text-ink-3">{row.label}</dt>
              <dd className={`font-bold ${row.emphasis ? "text-h2 leading-[1.1]" : ""}`}>{row.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Avatar person={data.approver} />
            <div className="leading-[1.3]">
              <div className="text-lg font-extrabold">{data.approver.name}</div>
              <div className="text-ink-2">{data.approver.roleDetail}</div>
            </div>
          </div>
          <span className="rounded-full bg-human-50 px-3.5 py-1 text-base font-bold text-human">{data.chip}</span>
        </div>

        <div className="mt-5">
          <ConfirmCheckbox label={data.checkboxLabel} checked={checked} disabled={!allowed || busy} onChange={setChecked} />
        </div>

        {!allowed && (
          <p role="status" className="mt-3 text-base font-bold text-human">
            {data.waitingLabel}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-base font-bold text-danger">
            {error}
          </p>
        )}

        <div className="mt-[26px] flex justify-end gap-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-14 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink disabled:opacity-60"
          >
            {data.cancelLabel}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={!allowed || !checked || busy}
            className="h-14 rounded-md bg-human px-7 text-lg font-bold text-white disabled:opacity-50"
          >
            {data.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
