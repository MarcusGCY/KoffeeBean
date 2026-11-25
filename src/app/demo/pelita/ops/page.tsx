import { connection } from "next/server";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { approvalView } from "@/lib/demo/approval-view";
import { requirePresenterPage } from "@/lib/demo/guard";
import { listingDraftView } from "@/lib/demo/listing-view";
import { opsConsoleView } from "@/lib/demo/ops-console";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoState, type DemoState } from "@/lib/demo/state";
import { stockCheckView } from "@/lib/demo/stock-check-view";

export const instant = false;

export const metadata = {
  title: "Pelita ops console",
  robots: { index: false, follow: false },
};

const EMPTY_STATE: Pick<DemoState, "stage" | "approvals" | "audit" | "listed"> = { stage: 0, approvals: {}, audit: [], listed: false };

export default async function PelitaOpsPage() {
  await connection();
  await requirePresenterPage();
  // A store that is not configured or is down still shows screen 01 as a new proposal.
  const state = await getDemoState().catch(() => EMPTY_STATE);
  const scenario = loadScenario();
  return (
    <PelitaOpsConsole
      view={opsConsoleView(scenario, state)}
      approval={approvalView(scenario, state)}
      stockCheck={stockCheckView(scenario, state)}
      listing={listingDraftView(scenario, state)}
    />
  );
}
