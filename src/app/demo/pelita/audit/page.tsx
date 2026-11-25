import { connection } from "next/server";
import { PelitaAuditTimeline } from "@/components/pelita-ops/PelitaAuditTimeline";
import { auditView } from "@/lib/demo/audit-view";
import { requirePresenterPage } from "@/lib/demo/guard";
import { loadScenario } from "@/lib/demo/scenario";
import { getDemoSnapshot } from "@/lib/demo/state";

export const instant = false;

export const metadata = {
  title: "Pelita audit trail",
  robots: { index: false, follow: false },
};

export default async function PelitaAuditPage() {
  await connection();
  await requirePresenterPage();
  // A store that is not configured or is down shows an unavailable notice, never an empty trail.
  const snapshot = await getDemoSnapshot().catch(() => null);
  return <PelitaAuditTimeline view={auditView(loadScenario(), snapshot ? { ...snapshot.state, elapsedMode: snapshot.elapsedMode } : null)} />;
}
