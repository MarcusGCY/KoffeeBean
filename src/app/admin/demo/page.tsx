import { connection } from "next/server";
import { notFound } from "next/navigation";
import { DemoPostForm, RefreshWhileDeploying } from "@/components/DemoControls";
import { SiteHeader } from "@/components/SiteHeader";
import { listDemoFixes, type DemoFixRow, type DemoOverview } from "@/lib/demo-actions";
import { demoCsrfToken, revertGrant } from "@/lib/demo-auth";
import { githubDemoRepo, publicGitHubError } from "@/lib/demo-repo";
import { readAdmin } from "@/lib/demo-session";
import { appOrigin } from "@/lib/origin";

export const instant = false;

export const metadata = {
  title: "BeanBox",
  robots: { index: false, follow: false },
};

const FLASHES = new Set(["reverted", "already", "reset", "reset-already", "conflict", "error"]);

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const admin = await readAdmin();
  if (!admin) notFound();

  const params = await searchParams;
  const flash = first(params.flash);
  const detail = first(params.detail);
  const notice = flash && FLASHES.has(flash) ? { flash, detail: detail?.slice(0, 300) } : null;

  let overview: DemoOverview | undefined;
  let loadError: string | undefined;
  try {
    overview = await listDemoFixes(githubDemoRepo());
  } catch (error) {
    console.error("[demo] list failed", error);
    loadError = publicGitHubError(error);
  }

  let csrf: string | undefined;
  let formError: string | undefined;
  try {
    csrf = demoCsrfToken(admin.id);
  } catch (error) {
    formError = error instanceof Error ? error.message : "Forms cannot be signed.";
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <SiteHeader shopper={{ email: admin.email }} demoHref="/admin/demo" />
      <RefreshWhileDeploying active={Boolean(overview?.deployingMain)} />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <p className="text-sm font-semibold uppercase tracking-wider text-amber-800">Owner</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Demo controls</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Revert a merged Cursor fix so the shop bug comes back after Vercel redeploys main.
          The feedback issue is closed and labeled <code className="font-mono">demo-reverted</code>,
          so the next report opens a fresh issue.
        </p>

        {notice && (
          <p
            className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-relaxed ${
              notice.flash === "conflict" || notice.flash === "error"
                ? "border-red-200 bg-red-50 text-red-950"
                : "border-green-200 bg-green-50 text-green-950"
            }`}
          >
            {notice.detail || notice.flash}
          </p>
        )}
        {loadError && (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950">
            Could not load fixes. {loadError}
          </p>
        )}
        {formError && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {formError} Revert stays disabled until <code className="font-mono">APPROVAL_SECRET</code> is set.
          </p>
        )}
        {overview?.deployingMain && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            Main is {short(overview.mainSha)} and this deployment is {short(overview.deployedSha)}.
            Vercel is redeploying. This page refreshes until they match.
          </p>
        )}

        <section className="mt-8 rounded-xl border border-stone-200 bg-white p-5">
          <h2 className="text-lg font-semibold">Reset all demo bugs</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            Puts back the three bugs from <code className="font-mono">5cb6889</code>: the bean image
            path, the Canvas Tote not adding to the cart, and the Roast Day T-Shirt at $250.
            Files that already have the bug are left alone. If a line does not match, nothing is committed.
          </p>
          <div className="mt-4">
            <DemoPostForm
              action="/api/demo/reset"
              fields={csrf ? { csrf } : {}}
              label="Reset all demo bugs"
              confirm="Restore the three planted demo bugs on main?"
              disabled={!csrf}
              tone="neutral"
            />
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Recent feedback fixes</h2>
          {overview && overview.rows.length === 0 && !loadError && (
            <p className="mt-3 text-sm text-stone-600">No feedback issue with a Cursor pull request yet.</p>
          )}
          <ul className="mt-3 space-y-3">
            {overview?.rows.map((row) => (
              <li key={`${row.issueNumber}-${row.prNumber}`} className="rounded-xl border border-stone-200 bg-white p-4">
                <FixRow row={row} csrf={csrf} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function FixRow({ row, csrf }: { row: DemoFixRow; csrf?: string }) {
  const revertUrl = csrf ? signedRevertUrl(row.prNumber) : undefined;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={row.statusLabel} status={row.status} />
          <a href={row.issueUrl} className="text-sm font-medium text-amber-800 hover:underline">
            #{row.issueNumber}
          </a>
          <a href={row.prUrl} className="text-sm text-stone-600 hover:underline">
            PR {row.prNumber}
          </a>
          {row.mergeSha && (
            <span className="font-mono text-xs text-stone-500">{short(row.mergeSha)}</span>
          )}
        </div>
        <p className="mt-1 text-sm text-stone-800">{row.issueTitle}</p>
        {revertUrl && row.canRevert && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-stone-500">Signed POST link for the Feedback Bot</summary>
            <p className="mt-1 break-all font-mono text-xs text-stone-600">{revertUrl}</p>
            <p className="mt-1 text-xs text-stone-500">
              Valid for 24 hours. POST it. It is not added to the review or fix webhooks.
            </p>
          </details>
        )}
      </div>
      {row.canRevert && (
        <DemoPostForm
          action="/api/demo/revert"
          fields={{
            pr: String(row.prNumber),
            issue: String(row.issueNumber),
            ...(csrf ? { csrf } : {}),
          }}
          label="Revert"
          confirm={`Revert PR ${row.prNumber} on main? The bug will come back after Vercel redeploys.`}
          disabled={!csrf}
        />
      )}
    </div>
  );
}

function StatusBadge({ label, status }: { label: string; status: DemoFixRow["status"] }) {
  const tone =
    status === "merged"
      ? "bg-green-100 text-green-900"
      : status === "reverted"
        ? "bg-amber-100 text-amber-950"
        : "bg-stone-100 text-stone-700";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function signedRevertUrl(pr: number): string {
  const path = `/api/demo/revert?pr=${pr}&token=${encodeURIComponent(revertGrant(pr))}`;
  try {
    return `${appOrigin()}${path}`;
  } catch {
    return path;
  }
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}
