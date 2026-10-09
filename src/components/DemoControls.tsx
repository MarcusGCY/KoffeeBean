"use client";

import { useEffect, useState } from "react";

export function DemoPostForm({
  action,
  fields,
  label,
  confirm,
  disabled = false,
  tone = "danger",
}: {
  action: string;
  fields: Record<string, string>;
  label: string;
  confirm: string;
  disabled?: boolean;
  tone?: "danger" | "neutral";
}) {
  const [pending, setPending] = useState(false);
  const className =
    tone === "danger"
      ? "rounded bg-red-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-900 disabled:cursor-not-allowed disabled:bg-stone-300"
      : "rounded border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400";

  return (
    <form
      method="post"
      action={action}
      onSubmit={(event) => {
        if (disabled || pending) {
          event.preventDefault();
          return;
        }
        if (!window.confirm(confirm)) {
          event.preventDefault();
          return;
        }
        setPending(true);
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" disabled={disabled || pending} className={className}>
        {pending ? "Working…" : label}
      </button>
    </form>
  );
}

/** Reloads while main is ahead of this deployment so the status can leave "deploying". */
export function RefreshWhileDeploying({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => window.location.reload(), 20_000);
    return () => window.clearInterval(id);
  }, [active]);
  return null;
}
