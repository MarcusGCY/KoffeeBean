import { Suspense } from "react";
import { BackLink } from "@/components/ActivityList";
import { LocationConsent } from "@/components/LocationConsent";
import { LoginGate } from "@/components/LoginGate";
import { SiteHeader } from "@/components/SiteHeader";
import { auth0Configured } from "@/lib/auth0";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { readLocation } from "@/lib/location-consent";
import { getShopper } from "@/lib/shopper";
import type { Shopper } from "@/lib/types";

export const metadata = { title: "Your area · BeanBox" };

export default function LocationPage() {
  return (
    <Suspense fallback={<Shell>{<p className="px-4 py-10 text-sm text-stone-500">Loading…</p>}</Shell>}>
      <LocationBody />
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
          <h1 className="flex-1 text-[17px] font-semibold tracking-tight">Your area</h1>
        </div>
        <div className="p-3">{children}</div>
      </main>
    </div>
  );
}

async function LocationBody() {
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
        <p className="py-10 text-center text-stone-500">The store is unavailable right now.</p>
      </Shell>
    );
  }
  let location: Awaited<ReturnType<typeof readLocation>>;
  try {
    location = await readLocation(shopper.id);
  } catch {
    return (
      <Shell shopper={shopper}>
        <p className="py-10 text-center text-stone-500">Your area could not be loaded. Try again in a moment.</p>
      </Shell>
    );
  }
  return (
    <Shell shopper={shopper}>
      <LocationConsent initial={location} />
    </Shell>
  );
}
