import { connection } from "next/server";
import { notFound } from "next/navigation";
import { PelitaProductDetail } from "@/components/pelita/PelitaProductDetail";
import type { PelitaAccount } from "@/components/pelita/PelitaStorefront";
import { requirePresenterPage } from "@/lib/demo/guard";
import { isLaunchSku } from "@/lib/demo/launch";
import { readLaunch } from "@/lib/demo/launch-store";
import { resolveProductPage } from "@/lib/demo/launch-view";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoSnapshot } from "@/lib/demo/state";
import { PELITA_SIGN_IN_HREF } from "@/lib/return-to";
import { getShopper } from "@/lib/shopper";

export const instant = false;

export const metadata = {
  title: "Pelita product",
  robots: { index: false, follow: false },
};

function previewRequested(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

function decodeSku(value: string): string | null {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return null;
  }
}

export default async function PelitaProductPage(props: {
  params: Promise<{ sku: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requirePresenterPage();
  const { sku: rawSku } = await props.params;
  const query = await props.searchParams;
  const sku = decodeSku(rawSku);
  if (!sku || !isLaunchSku(sku)) notFound();

  const scenario = loadScenario();
  const snapshot = await getDemoSnapshot().catch(() => null);
  const config = await readLaunch(sku).catch(() => null);
  const resolved = resolveProductPage({
    sku,
    scenario,
    listed: snapshot?.state.listed === true,
    config,
    preview: previewRequested(query.preview),
  });
  if (resolved.hidden) notFound();

  const session = await signedInAccount();
  return (
    <PelitaProductDetail
      product={resolved.product}
      wordmark={scenario.brand.wordmark}
      account={session.account}
      yuuSignInHref={session.account ? undefined : PELITA_SIGN_IN_HREF}
    />
  );
}

async function signedInAccount(): Promise<{ account: PelitaAccount | null }> {
  try {
    const shopper = await getShopper();
    if (!shopper) return { account: null };
    return { account: { name: shopper.name, email: shopper.email, picture: shopper.picture } };
  } catch {
    console.error("[pelita] session check failed");
    return { account: null };
  }
}
