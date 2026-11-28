import { connection } from "next/server";
import { PelitaPartnerPurchases } from "@/components/pelita/PelitaPartnerPurchases";
import type { PelitaAccount } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { listLaunches } from "@/lib/demo/launch-store";
import { builtinLaunches } from "@/lib/demo/launch-packages";
import { applyLaunchesToPartners } from "@/lib/demo/launch-view";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoSnapshot } from "@/lib/demo/state";
import { partnerOffers } from "@/lib/demo/yuu-partners";
import { PELITA_YUU_SIGN_IN_HREF } from "@/lib/return-to";
import { getShopper } from "@/lib/shopper";
import { loadStorefrontYuu } from "@/lib/yuu/read";

export const instant = false;

export const metadata = {
  title: "yuu partner purchases",
  robots: { index: false, follow: false },
};

export default async function PelitaYuuPartnersPage() {
  await connection();
  await requirePresenterPage();
  const scenario = loadScenario();
  const snapshot = await getDemoSnapshot().catch(() => null);
  const listed = snapshot?.state.listed === true;
  const launches = await listLaunches().catch(() => builtinLaunches());
  const session = await signedInAccount();
  const yuu = await loadStorefrontYuu(session.memberKey);
  const balance = yuu.signedInMember
    ? { points: yuu.signedInMember.points, tier: yuu.signedInMember.tier }
    : null;
  return (
    <PelitaPartnerPurchases
      offers={applyLaunchesToPartners(partnerOffers(scenario, listed), scenario, launches)}
      account={session.account}
      signInHref={PELITA_YUU_SIGN_IN_HREF}
      wordmark={scenario.brand.wordmark}
      initialBalance={balance}
    />
  );
}

/** Header identity. A session failure leaves the page public and signed out. */
async function signedInAccount(): Promise<{ account: PelitaAccount | null; memberKey: string | null }> {
  try {
    const shopper = await getShopper();
    if (!shopper) return { account: null, memberKey: null };
    return {
      account: { name: shopper.name, email: shopper.email, picture: shopper.picture },
      memberKey: shopper.id,
    };
  } catch {
    console.error("[pelita] session check failed");
    return { account: null, memberKey: null };
  }
}
