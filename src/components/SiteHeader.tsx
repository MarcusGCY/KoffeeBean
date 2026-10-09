"use client";

import Link from "next/link";
import type { Shopper } from "@/lib/types";

export function SiteHeader({
  shopper = null,
  itemCount,
  pending = false,
  demoHref,
}: {
  shopper?: Pick<Shopper, "name" | "email"> | null;
  itemCount?: number;
  pending?: boolean;
  demoHref?: string;
}) {
  const label = shopper?.name || shopper?.email;

  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">
          <Link href="/">
            BeanBox <span className="text-amber-700">Coffee Co.</span>
          </Link>
        </h1>
        <div className="flex items-center gap-3 sm:gap-4">
          {pending ? (
            <span className="text-sm text-stone-400">Loading…</span>
          ) : shopper ? (
            <>
              {itemCount !== undefined && (
                <span className="text-sm text-stone-600">{itemCount} items</span>
              )}
              {label && (
                <span className="hidden max-w-48 truncate text-sm text-stone-700 sm:inline" title={label}>
                  {label}
                </span>
              )}
              {demoHref && (
                <Link href={demoHref} className="text-sm font-medium text-amber-800 hover:underline">
                  Demo
                </Link>
              )}
              <a
                href="/auth/logout"
                className="rounded border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-800 hover:bg-stone-100"
              >
                Log out
              </a>
            </>
          ) : (
            <a
              href="/auth/login"
              className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800"
            >
              Log in
            </a>
          )}
        </div>
      </div>
    </header>
  );
}
