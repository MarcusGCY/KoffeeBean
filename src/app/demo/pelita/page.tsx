import { connection } from "next/server";
import { PelitaStorefront, type PelitaAccount } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { listLaunches } from "@/lib/demo/launch-store";
import { builtinLaunches } from "@/lib/demo/launch-packages";
import { applyLaunchConfigs } from "@/lib/demo/launch-view";
import { publishedView } from "@/lib/demo/published-view";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoSnapshot } from "@/lib/demo/state";
import { storefrontView } from "@/lib/demo/storefront";
import { getShopper } from "@/lib/shopper";
import { loadStorefrontYuu } from "@/lib/yuu/read";

export const instant = false;

export const metadata = {
  title: "Pelita Health & Beauty",
  robots: { index: false, follow: false },
};

export default async function PelitaStorefrontPage() {
  await connection();
  await requirePresenterPage();
  const scenario = loadScenario();
  // A store that is not configured or is down shows the storefront as it was before the launch.
  const snapshot = await getDemoSnapshot().catch(() => null);
  const state = snapshot ? { ...snapshot.state, elapsedMode: snapshot.elapsedMode } : null;
  const listed = state?.listed === true;
  const launches = await listLaunches().catch(() => builtinLaunches());
  const session = await signedInAccount();
  const yuu = await loadStorefrontYuu(session.memberKey);
  const view = applyLaunchConfigs(
    storefrontView(scenario, { listed, published: state ? publishedView(scenario, state) : null }),
    scenario,
    launches,
  );
  return <PelitaStorefront view={view} account={session.account} yuu={yuu} />;
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
