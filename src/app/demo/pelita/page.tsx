import { connection } from "next/server";
import { PelitaStorefront, type PelitaAccount } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { publishedView } from "@/lib/demo/published-view";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoSnapshot } from "@/lib/demo/state";
import { storefrontView } from "@/lib/demo/storefront";
import { getShopper } from "@/lib/shopper";

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
  const account = await signedInAccount();
  return (
    <PelitaStorefront
      view={storefrontView(scenario, { listed, published: state ? publishedView(scenario, state) : null })}
      account={account}
    />
  );
}

/** Header identity. A session failure leaves the page public and signed out. */
async function signedInAccount(): Promise<PelitaAccount | null> {
  try {
    const shopper = await getShopper();
    if (!shopper) return null;
    return { name: shopper.name, email: shopper.email, picture: shopper.picture };
  } catch {
    console.error("[pelita] session check failed");
    return null;
  }
}
