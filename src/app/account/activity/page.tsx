import { Suspense } from "react";
import { ActivityList, BackLink } from "@/components/ActivityList";
import { LoginGate } from "@/components/LoginGate";
import { SiteHeader } from "@/components/SiteHeader";
import { groupActivity } from "@/lib/agent-activity-text";
import { auth0Configured } from "@/lib/auth0";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { getShopper } from "@/lib/shopper";
import type { Shopper } from "@/lib/types";
import { readActivityView } from "@/lib/store-meta";

export const metadata = { title: "Agent activity · BeanBox" };

export default function ActivityPage() {
  return (
    <Suspense fallback={<Shell>{<p className="px-4 py-10 text-sm text-stone-500">Loading…</p>}</Shell>}>
      <Activity />
    </Suspense>
  );
}

function Shell({
  children,
  demo = false,
  shopper = null,
}: {
  children: React.ReactNode;
  demo?: boolean;
  shopper?: Pick<Shopper, "name" | "email"> | null;
}) {
  return (
    <div className="min-h-screen bg-stone-50 font-sans text-[15px] text-stone-900">
      <SiteHeader shopper={shopper} />
      <main className="mx-auto max-w-lg bg-white">
        <div className="flex h-[52px] items-center gap-1 border-b border-stone-200 px-1">
          <BackLink href="/" label="Back to the shop" />
          <h1 className="flex-1 text-[17px] font-semibold tracking-tight">Agent activity</h1>
          {demo && (
            <span className="mr-2 rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
              Demo data
            </span>
          )}
        </div>
        {children}
      </main>
    </div>
  );
}

async function Activity() {
  const shopper = await getShopper();
  if (!shopper) {
    return (
      <div className="min-h-screen bg-stone-50 text-stone-900">
        <SiteHeader shopper={null} />
        <LoginGate configured={auth0Configured()} />
      </div>
    );
  }
  if (!mgmtConfigured()) {
    return (
      <Shell shopper={shopper}>
        <p className="px-4 py-10 text-center text-stone-500">The store is unavailable right now.</p>
      </Shell>
    );
  }
  let view: Awaited<ReturnType<typeof readActivityView>>;
  try {
    view = await readActivityView(shopper.id);
  } catch {
    return (
      <Shell shopper={shopper}>
        <p className="px-4 py-10 text-center text-stone-500">Activity could not be loaded. Try again in a moment.</p>
      </Shell>
    );
  }
  const now = new Date();
  const byId = new Map(view.entries.map((entry) => [entry.id, entry]));
  const groups = groupActivity(view.entries, now).map((group) => ({
    ...group,
    entries: group.entries.flatMap((entry) => (byId.has(entry.id) ? [byId.get(entry.id)!] : [])),
  }));
  return (
    <Shell demo={view.demo} shopper={shopper}>
      <ActivityList groups={groups} />
    </Shell>
  );
}
