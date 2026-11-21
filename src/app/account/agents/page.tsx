import { Suspense } from "react";
import { BackLink } from "@/components/ActivityList";
import { ConnectedAgents } from "@/components/ConnectedAgents";
import { LoginGate } from "@/components/LoginGate";
import { SiteHeader } from "@/components/SiteHeader";
import { auth0Configured } from "@/lib/auth0";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { readAgentsView } from "@/lib/connected-agents";
import { getShopper } from "@/lib/shopper";
import type { Shopper } from "@/lib/types";

export const metadata = { title: "Connected agents · BeanBox" };

export default function AgentsPage() {
  return (
    <Suspense fallback={<Shell>{<p className="px-4 py-10 text-sm text-stone-500">Loading…</p>}</Shell>}>
      <Agents />
    </Suspense>
  );
}

function Shell({ children, shopper = null }: { children: React.ReactNode; shopper?: Pick<Shopper, "name" | "email"> | null }) {
  return (
    <div className="min-h-screen bg-stone-50 font-sans text-[15px] text-stone-900">
      <SiteHeader shopper={shopper} />
      <main className="mx-auto max-w-lg">
        <div className="flex h-[52px] items-center gap-1 border-b border-stone-200 bg-white px-1">
          <BackLink href="/" label="Back to the shop" />
          <h1 className="flex-1 text-[17px] font-semibold tracking-tight">Connected agents</h1>
          <span className="mr-2 rounded-full border border-dashed border-stone-300 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
            Demo data
          </span>
        </div>
        {children}
      </main>
    </div>
  );
}

async function Agents() {
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
  let view: Awaited<ReturnType<typeof readAgentsView>>;
  try {
    view = await readAgentsView(shopper.id);
  } catch {
    return (
      <Shell shopper={shopper}>
        <p className="px-4 py-10 text-center text-stone-500">Agents could not be loaded. Try again in a moment.</p>
      </Shell>
    );
  }
  return (
    <Shell shopper={shopper}>
      <ConnectedAgents initial={view} />
    </Shell>
  );
}
