import { Suspense } from "react";
import { LoginGate } from "@/components/LoginGate";
import { SiteHeader } from "@/components/SiteHeader";
import { Store } from "@/components/Store";
import { auth0Configured } from "@/lib/auth0";
import { readAdmin } from "@/lib/demo-session";
import { getShopper } from "@/lib/shopper";

export default function Home() {
  return (
    <Suspense fallback={<StoreLoading />}>
      <Storefront />
    </Suspense>
  );
}

function StoreLoading() {
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <SiteHeader pending />
      <p className="mx-auto max-w-6xl px-6 py-16 text-sm text-stone-500">Loading the shop…</p>
    </div>
  );
}

async function Storefront() {
  const shopper = await getShopper();
  if (!shopper) {
    return (
      <div className="min-h-screen bg-stone-50 text-stone-900">
        <SiteHeader shopper={null} />
        <LoginGate configured={auth0Configured()} />
      </div>
    );
  }
  const admin = await readAdmin();
  return <Store shopper={shopper} demoHref={admin ? "/admin/demo" : undefined} />;
}
