import { connection } from "next/server";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { publishedView } from "@/lib/demo/published-view";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoState } from "@/lib/demo/state";
import { storefrontView } from "@/lib/demo/storefront";

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
  const state = await getDemoState().catch(() => null);
  const listed = state?.listed === true;
  return <PelitaStorefront view={storefrontView(scenario, { listed, published: state ? publishedView(scenario, state) : null })} />;
}
