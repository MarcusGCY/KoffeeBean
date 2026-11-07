import { connection } from "next/server";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { readAdmin } from "@/lib/demo-session";
import { githubHttpStatus } from "@/lib/github";
import { loadQualityAudit, type QualityAudit } from "@/lib/quality-audit";

export const instant = false;

export const metadata = {
  title: "Quality audit",
  robots: { index: false, follow: false },
};

export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const admin = await readAdmin();
  if (!admin) notFound();
  const params = await searchParams;
  const raw = first(params.issue);
  const issue = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;

  let audit: QualityAudit | undefined;
  let loadError: string | undefined;
  if (issue) {
    try {
      audit = await loadQualityAudit(issue);
    } catch (error) {
      console.error("[quality] page read failed", error instanceof Error ? error.name : "Error");
      loadError = githubHttpStatus(error) === 404 ? "That issue was not found." : "Could not load this issue.";
    }
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <SiteHeader shopper={{ email: admin.email }} demoHref="/admin/demo" />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-amber-800">Owner</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Quality audit</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Privacy-safe trail for one feedback issue. Webhook delivery is not a room
          acknowledgement. Adoption and verification links do not launch a second fix.
        </p>
        <form className="mt-4 flex flex-wrap items-end gap-3" action="/admin/quality" method="get">
          <label className="text-sm font-medium" htmlFor="issue">
            Issue number
            <input
              id="issue"
              name="issue"
              inputMode="numeric"
              required
              defaultValue={raw ?? ""}
              className="mt-1 block w-32 rounded-md border border-stone-300 bg-white px-3 py-2"
            />
          </label>
          <button type="submit" className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white">
            Show trail
          </button>
        </form>
        {loadError && (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950" role="alert">
            {loadError}
          </p>
        )}
        {audit && <AuditView audit={audit} />}
      </main>
    </div>
  );
}

function AuditView({ audit }: { audit: QualityAudit }) {
  return (
    <section className="mt-6 space-y-4">
      <h2 className="text-lg font-semibold">Issue #{audit.issue}</h2>
      <p className="text-sm">{audit.severityLine}</p>
      <p className="text-sm text-stone-700">
        Next owner: {audit.next ? `${audit.next.owner} (${audit.next.stage})` : "none"}.
        {audit.next?.blocker ? ` Blocker: ${audit.next.blocker}.` : ""}
      </p>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div><dt className="font-medium">Case</dt><dd className="font-mono">{audit.caseId ?? "not stored"}</dd></div>
        <div><dt className="font-medium">Correlation</dt><dd className="font-mono">{audit.correlationId ?? "not stored"}</dd></div>
        <div><dt className="font-medium">Fix launched</dt><dd>{audit.tracking.fixLaunched ? "yes" : "no"}</dd></div>
        <div><dt className="font-medium">Engineering adoption</dt><dd>{audit.tracking.engineeringAdoption}</dd></div>
        <div><dt className="font-medium">Verification</dt><dd>{audit.tracking.verification}</dd></div>
        <div><dt className="font-medium">fix_started webhook</dt><dd>{audit.tracking.notifyFixStarted}</dd></div>
        <div><dt className="font-medium">fix_completed webhook</dt><dd>{audit.tracking.notifyFixCompleted}</dd></div>
      </dl>
      {audit.unresolved.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Unresolved</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {audit.unresolved.map((item) => (
              <li key={item.stage}>
                {item.stage}: {item.owner}. {item.blocker}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Quality stages</caption>
          <thead>
            <tr className="border-b border-stone-300">
              <th scope="col" className="py-2 pr-3">Stage</th>
              <th scope="col" className="py-2 pr-3">Status</th>
              <th scope="col" className="py-2 pr-3">Source</th>
              <th scope="col" className="py-2 pr-3">Next</th>
            </tr>
          </thead>
          <tbody>
            {audit.stages.map((stage, index) => (
              <tr key={`${stage.stage}-${stage.actionId ?? index}`} className="border-b border-stone-200 align-top">
                <th scope="row" className="py-2 pr-3 font-medium">{stage.stage}</th>
                <td className="py-2 pr-3">{stage.status}</td>
                <td className="py-2 pr-3">{stage.source}</td>
                <td className="py-2 pr-3">{stage.nextOwner}{stage.blocker ? ` — ${stage.blocker}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="list-disc pl-5 text-sm text-stone-600">
        {audit.limits.map((limit) => <li key={limit}>{limit}</li>)}
      </ul>
    </section>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  const found = Array.isArray(value) ? value[0] : value;
  return found?.trim() || undefined;
}
