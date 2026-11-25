import { connection } from "next/server";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { loadScenario } from "@/lib/demo/scenario";
import { storefrontView } from "@/lib/demo/storefront";

export const instant = false;

export const metadata = {
  title: "Pelita Health & Beauty",
  robots: { index: false, follow: false },
};

export default async function PelitaStorefrontPage() {
  await connection();
  await requirePresenterPage();
  return <PelitaStorefront view={storefrontView(loadScenario())} />;
}
