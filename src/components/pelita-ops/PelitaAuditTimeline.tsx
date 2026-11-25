import Link from "next/link";
import { OPS_LINK_LABEL, OPS_PATH, STOREFRONT_LABEL } from "@/lib/demo/audit-links";
import type { AuditChange, AuditEntry, AuditView } from "@/lib/demo/audit-view";
import { STOREFRONT_PATH } from "@/lib/demo/published-view";
import { PelitaElapsedToggle } from "./PelitaElapsedToggle";
import { HumanIcon, PelitaMark, SparkleIcon, SuccessIcon, UserIcon } from "../pelita/PelitaIcons";
import { Rail } from "./PelitaOpsConsole";

const SMALL_LINK = "whitespace-nowrap text-base font-semibold text-ink-3 underline underline-offset-4";

/**
 * Violet is the agent, navy is a human approval and nothing else, green is the system.
 * A human edit or send is a person but not an approval, so it gets a plain outline person in ink.
 */
function ActorMark({ entry }: { entry: AuditEntry }) {
  if (entry.kind === "agent") return <span className="text-agent"><SparkleIcon size={28} /></span>;
  if (entry.kind === "system") return <SuccessIcon size={28} />;
  if (entry.humanKind === "approval") return <span className="text-human"><HumanIcon size={28} /></span>;
  return <span className="text-ink-2"><UserIcon /></span>;
}

function actorClass(entry: AuditEntry): string {
  if (entry.kind === "agent") return "text-agent";
  if (entry.kind === "system") return "text-success-text";
  return entry.humanKind === "approval" ? "text-human" : "text-ink-2";
}

function Change({ change }: { change: AuditChange }) {
  return (
    <div data-audit-change className="mt-0.5 text-base font-semibold leading-6 text-ink-2">
      <div className="truncate" title={change.before}>
        <span className="text-ink-3">{change.label} · Before:</span> <del className="text-danger">{change.before}</del>
        {change.note && <span className="ml-2 text-ink-3">({change.note})</span>}
      </div>
      <div className="truncate" title={change.after}>
        <span className="text-ink-3">After:</span> <span className="text-success-text">{change.after}</span>
      </div>
    </div>
  );
}

function Row({ entry }: { entry: AuditEntry }) {
  const approval = entry.humanKind === "approval";
  return (
    <tr
      data-audit-row
      data-actor-kind={entry.kind}
      data-human-kind={entry.humanKind ?? undefined}
      className={`border-b border-line-2 align-top ${approval ? "bg-human-50" : ""}`}
    >
      <td className="whitespace-nowrap py-1 pr-4 pl-1 text-base font-extrabold tabular-nums text-ink">{entry.timeLabel}</td>
      <td className="py-0.5 pr-3">
        <ActorMark entry={entry} />
      </td>
      <td className={`py-1 pr-4 text-base font-bold leading-6 ${actorClass(entry)}`}>
        {entry.actor}
        {entry.humanLabel && (
          <span className={approval ? "sr-only" : "block text-base font-semibold leading-5 text-ink-3"}>
            {approval && ", "}
            {entry.humanLabel}
          </span>
        )}
      </td>
      <td className="py-1 pr-4 text-base font-bold leading-6 text-ink">
        {entry.action}
        {entry.change && <Change change={entry.change} />}
      </td>
      <td className="py-1 pr-4 text-base leading-6 text-ink-2">{entry.source}</td>
      <td className={`whitespace-nowrap py-1 pr-1 text-base font-extrabold leading-6 ${approval ? "text-human" : "text-ink"}`}>{entry.ref ?? "—"}</td>
    </tr>
  );
}

function Pill({ className, children, ...rest }: { className: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return <span {...rest} className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1 text-base font-bold ${className}`}>{children}</span>;
}

/** Screen 07: the audit timeline, read-only, from the persisted audit rows. */
export function PelitaAuditTimeline({ view }: { view: AuditView }) {
  const { person } = view;
  return (
    <div className="flex h-screen min-h-[640px] flex-col" data-audit-timeline>
      <header className="flex h-20 items-center gap-5 border-b border-line-2 bg-surface px-12">
        <div className="flex items-center gap-3">
          <PelitaMark />
          <div>
            <div className="text-[30px] font-extrabold leading-none tracking-[-0.6px] text-ink">{view.brand.wordmark}</div>
            <div className="mt-[5px] text-[12px] font-extrabold leading-none tracking-[2.6px] text-primary">{view.brand.wordmarkSub}</div>
          </div>
        </div>
        <div aria-hidden="true" className="h-9 w-0.5 bg-line-2" />
        <div className="whitespace-nowrap text-lg font-bold text-ink-2">{view.consoleTitle}</div>
        <div className="flex-1" />
        <PelitaElapsedToggle mode={view.elapsedMode} />
        <Link href={OPS_PATH} className={SMALL_LINK}>
          {OPS_LINK_LABEL}
        </Link>
        <Link href={STOREFRONT_PATH} className={SMALL_LINK}>
          {STOREFRONT_LABEL}
        </Link>
        <span
          data-demo-tag
          className="inline-flex items-center whitespace-nowrap rounded-sm border-2 border-dashed border-ink bg-surface px-3 py-[3px] text-base font-extrabold tracking-[0.6px] text-ink"
        >
          {view.demoTag}
        </span>
        <div className="flex items-center gap-3 font-bold">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-[17px] font-extrabold text-white" aria-hidden="true">
            {person.initials}
          </span>
          <div className="whitespace-nowrap leading-tight">
            {person.name}
            <div className="text-base font-semibold text-ink-3">{person.role}</div>
          </div>
        </div>
      </header>

      <Rail steps={view.steps} />

      <main className="flex min-h-0 flex-1 flex-col px-12 py-5">
        <section aria-labelledby="audit-title" className="flex min-h-0 flex-col rounded-xl border-2 border-line-2 bg-surface px-10 py-5">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div>
              <h1 id="audit-title" className="text-h2 font-extrabold tracking-[-0.4px]">
                {view.title}
              </h1>
              <p className="text-base font-semibold text-ink-3">
                {view.detectedLabel} · times in SGT
                {view.elapsed && <span data-elapsed-detail> · {view.elapsed.detail}</span>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5" data-audit-summary>
              {view.elapsed ? (
                <Pill className="bg-ink text-white">
                  <span data-elapsed>{view.elapsed.pill}</span>
                </Pill>
              ) : (
                <Pill className="bg-line-2 text-ink-2">
                  <span data-elapsed>{view.notLiveLabel}</span>
                </Pill>
              )}
              <Pill className="bg-agent-50 text-agent">
                <SparkleIcon size={20} />
                <span data-agent-count>{view.agent.label}</span>
              </Pill>
              <Pill className="bg-human-50 text-human" data-approvals-pill>
                <HumanIcon size={20} />
                <span data-approval-count>{view.approvals.label}</span>
                {view.approvals.refs.length > 0 && <span data-approval-refs>· {view.approvals.refs.join(", ")}</span>}
              </Pill>
              {view.otherHuman && (
                <Pill className="bg-line-2 text-ink-2">
                  <span data-other-human-count>{view.otherHuman.label}</span>
                </Pill>
              )}
            </div>
          </div>

          {view.unavailable ? (
            <p role="alert" data-audit-unavailable className="mt-6 rounded-lg bg-line-2 px-5 py-4 text-lg font-semibold text-ink-2">
              {view.unavailableLabel}
            </p>
          ) : view.entries.length === 0 ? (
            <p data-audit-empty className="mt-6 rounded-lg bg-line-2 px-5 py-4 text-lg font-semibold text-ink-2">
              {view.emptyLabel}
            </p>
          ) : (
            <div
              role="region"
              aria-label="Audit rows"
              tabIndex={0}
              className="mt-2 min-h-[180px] flex-1 overflow-y-auto"
            >
              <table className="w-full table-fixed border-collapse text-left">
                <colgroup>
                  <col className="w-[112px]" />
                  <col className="w-[48px]" />
                  <col className="w-[335px]" />
                  <col />
                  <col className="w-[225px]" />
                  <col className="w-[116px]" />
                </colgroup>
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b-2 border-line-2 text-base font-bold text-ink-3">
                    <th scope="col" className="whitespace-nowrap py-2 pr-4 pl-1">Time (SGT)</th>
                    <th scope="col" className="py-2 pr-3"><span className="sr-only">Kind</span></th>
                    <th scope="col" className="py-2 pr-4">Actor</th>
                    <th scope="col" className="py-2 pr-4">Action</th>
                    <th scope="col" className="py-2 pr-4">Data source</th>
                    <th scope="col" className="py-2 pr-1">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {view.entries.map((entry) => (
                    <Row key={entry.key} entry={entry} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-2.5 flex flex-none items-center gap-2.5 text-lg font-bold text-ink-2">
            <span className="text-ink-2">
              <HumanIcon size={26} />
            </span>
            {view.footer}
          </p>
        </section>
      </main>
    </div>
  );
}
