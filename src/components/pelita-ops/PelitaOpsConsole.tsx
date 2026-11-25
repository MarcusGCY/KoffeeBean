"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AUDIT_PATH } from "@/lib/demo/audit-links";
import { launchRail, type ApprovalView, type LaunchPhase, type RecordedApproval } from "@/lib/demo/approval-view";
import { approveRequest, refusalMessage, sendBackRequest } from "@/lib/demo/approval-client";
import { editListingRequest, listingMessage, runListingDraftRequest, sendForApprovalRequest } from "@/lib/demo/listing-client";
import type { ListingDraftView } from "@/lib/demo/listing-view";
import { formatCount, type OpsConsoleView, type ProposalStatus, type RailStep, type Rejection } from "@/lib/demo/ops-console";
import { rejectProposalRequest, resetDemoRequest } from "@/lib/demo/ops-client";
import { PELITA_ART } from "@/lib/demo/pelita-art";
import type { PublishedView } from "@/lib/demo/published-view";
import { continueStockCheckRequest, runStockCheckRequest, stockCheckMessage } from "@/lib/demo/stock-check-client";
import type { StockCheckView } from "@/lib/demo/stock-check-view";
import { PelitaMark, SparkleIcon, TickIcon } from "../pelita/PelitaIcons";
import { PelitaApprovalModal } from "./PelitaApprovalModal";
import { PelitaListingDraft, type ListingDraftStatus } from "./PelitaListingDraft";
import { PelitaLaunchApproval } from "./PelitaLaunchApproval";
import { PelitaStockCheck, type StockCheckStatus } from "./PelitaStockCheck";

const CURRENT_RING: Record<RailStep["kind"], string> = {
  agent: "border-agent",
  human: "border-human",
  system: "border-ink",
};
const CURRENT_DOT: Record<RailStep["kind"], string> = {
  agent: "bg-agent",
  human: "bg-human",
  system: "bg-ink",
};

/** The rail. With `auditHref`, the last step ("Audit") links to the audit timeline. */
export function Rail({ steps, auditHref }: { steps: RailStep[]; auditHref?: string }) {
  return (
    <ol aria-label="Launch steps" className="flex gap-2 px-12 pt-[18px]">
      {steps.map((step) => {
        const current = step.state === "current";
        const done = step.state === "done";
        return (
          <li
            key={step.n}
            aria-current={current ? "step" : undefined}
            className={`flex flex-1 items-center gap-2.5 whitespace-nowrap rounded-md bg-surface px-3 py-2.5 text-[17px] font-bold ${
              current ? `border-2 ${CURRENT_RING[step.kind]} text-ink` : `border border-line-2 ${done ? "text-ink-2" : "text-ink-3"}`
            }`}
          >
            <span
              className={`flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-base ${
                current ? `${CURRENT_DOT[step.kind]} text-white` : done ? "bg-success-50 text-success-text" : "bg-line-2 text-ink-2"
              }`}
            >
              {done ? <TickIcon /> : step.n}
              {done && <span className="sr-only">done</span>}
            </span>
            {auditHref && step.n === steps.length ? (
              <Link href={auditHref} data-audit-link className="underline underline-offset-4">
                {step.label}
              </Link>
            ) : (
              step.label
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ value, valueClass = "", children }: { value: string; valueClass?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line-2 bg-[#f8fafc] px-6 py-5">
      <div className={`text-display font-extrabold leading-[1.1] tracking-[-1px] ${valueClass}`}>{value}</div>
      <div className="mt-1 text-base font-semibold text-ink-2">{children}</div>
    </div>
  );
}

function Sparkline({ view }: { view: OpsConsoleView }) {
  const { chart, gap } = view;
  const line = chart.points.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <div className="rounded-lg border border-line-2 bg-[#f8fafc] px-5 pb-2.5 pt-4">
      <div className="mb-1 text-base font-bold text-ink">Searches per day</div>
      <svg
        role="img"
        aria-label={`Searches per day from ${gap.seriesStartLabel} to ${gap.seriesEndLabel}, rising from ${gap.searchesPerDay[0]} to ${gap.searchesPerDay[gap.searchesPerDay.length - 1]}`}
        width="100%"
        height={chart.height}
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        preserveAspectRatio="none"
        data-chart-max={gap.chartMax}
      >
        <polyline fill="none" stroke="#5B3FD1" strokeWidth="4" strokeLinejoin="round" points={line} />
        <circle cx={chart.last.x} cy={chart.last.y} r="7" fill="#5B3FD1" />
      </svg>
      <div className="flex justify-between text-base font-semibold text-ink-3">
        <span>{gap.seriesStartLabel}</span>
        <span>{gap.seriesEndLabel}</span>
      </div>
    </div>
  );
}

/**
 * Screen 01 (the demand-gap proposal) and, when `approval` is given, the two-person
 * approval over it: screen 02 (a modal) and screen 05. Violet is the agent, navy is
 * a human decision. Without `approval` the Approve button stays off. With
 * `stockCheck`, approving sourcing hands over to the agent's supplier and ERP check
 * (screen 03). With `listing`, the agent then drafts the listing, promo and claims
 * (screen 04), a human can edit it and send it for approval, and only that opens the
 * launch approval, whose "Approve and publish" really publishes (screen 06 is the storefront).
 */
export function PelitaOpsConsole({
  view,
  approval,
  stockCheck,
  listing,
}: {
  view: OpsConsoleView;
  approval?: ApprovalView;
  stockCheck?: StockCheckView;
  listing?: ListingDraftView;
}) {
  const [status, setStatus] = useState<ProposalStatus>(view.status);
  const [rejection, setRejection] = useState<Rejection | null>(view.rejection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<LaunchPhase | null>(approval?.phase ?? null);
  const [actingId, setActingId] = useState(approval?.defaultActorId ?? view.approverId);
  const [modalOpen, setModalOpen] = useState(false);
  const [sourcing, setSourcing] = useState<RecordedApproval | null>(approval?.recorded.sourcing ?? null);
  const [launch, setLaunch] = useState<RecordedApproval | null>(approval?.recorded.launch ?? null);
  const [sentBack, setSentBack] = useState(approval?.sentBack ?? null);
  const [stock, setStock] = useState<StockCheckView | null>(stockCheck ?? null);
  const [checkStatus, setCheckStatus] = useState<StockCheckStatus>(stockCheck?.complete ? "done" : "running");
  const checkStarted = useRef(false);
  const [draft, setDraft] = useState<ListingDraftView | null>(listing ?? null);
  const [draftStatus, setDraftStatus] = useState<ListingDraftStatus>(listing?.complete ? "done" : "running");
  const [launchData, setLaunchData] = useState(approval?.launch ?? null);
  const [published, setPublished] = useState<PublishedView | null>(approval?.published ?? null);
  const draftStarted = useRef(false);
  const { gap, proposal } = view;

  const actor = approval?.approvers.find((a) => a.id === actingId) ?? approval?.approvers[0];
  const other = approval?.approvers.find((a) => a.id !== actor?.id);
  const person = actor ?? view.person;

  function switchToSecondApprover() {
    const next = approval?.approvers.find((a) => a.slot === 2);
    if (next) setActingId(next.id);
  }

  async function runCheck() {
    setCheckStatus("running");
    setError(null);
    try {
      const result = await runStockCheckRequest();
      setStock(result.check);
      setCheckStatus("done");
    } catch (failure) {
      setCheckStatus("failed");
      setError(stockCheckMessage(failure));
    }
  }

  useEffect(() => {
    if (phase !== "stock_check" || !stock || stock.complete || checkStarted.current) return;
    checkStarted.current = true;
    void runCheck();
  }, [phase, stock]);

  async function runDraft() {
    setDraftStatus("running");
    setError(null);
    try {
      const result = await runListingDraftRequest();
      setDraft(result.draft);
      setLaunchData(result.launch);
      setDraftStatus("done");
    } catch (failure) {
      setDraftStatus("failed");
      setError(listingMessage(failure));
    }
  }

  useEffect(() => {
    if (phase !== "listing_draft" || !draft || draft.complete || draftStarted.current) return;
    draftStarted.current = true;
    void runDraft();
  }, [phase, draft]);

  async function continueFromCheck() {
    setBusy(true);
    setError(null);
    try {
      const result = await continueStockCheckRequest();
      setStock(result.check);
      setPhase(result.phase);
    } catch (failure) {
      setError(stockCheckMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function editDraft(description: string): Promise<boolean> {
    if (!actor) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await editListingRequest(actor.id, description);
      setDraft(result.draft);
      setLaunchData(result.launch);
      return true;
    } catch (failure) {
      setError(listingMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendDraft() {
    if (!actor) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendForApprovalRequest(actor.id);
      setDraft(result.draft);
      setLaunchData(result.launch);
      setPhase(result.phase);
      switchToSecondApprover();
    } catch (failure) {
      setError(listingMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function approve(slot: "sourcing" | "launch") {
    if (!actor) return;
    setBusy(true);
    setError(null);
    try {
      const result = await approveRequest(slot, actor.id);
      if (slot === "sourcing") {
        setSourcing(result.approval);
        setModalOpen(false);
        if (!stock) switchToSecondApprover();
      } else {
        setLaunch(result.approval);
        setPublished(result.published);
      }
      if (slot === "sourcing" && stock) {
        checkStarted.current = true;
        setPhase("stock_check");
        void runCheck();
      } else {
        setPhase(result.phase);
      }
    } catch (failure) {
      setError(refusalMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function sendBack() {
    if (!actor) return;
    setBusy(true);
    setError(null);
    try {
      setSentBack(await sendBackRequest(actor.id));
      setPhase("sent_back");
    } catch (failure) {
      setError(refusalMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    setError(null);
    try {
      setRejection(await rejectProposalRequest());
      setStatus("rejected");
      if (approval) setPhase("rejected");
    } catch {
      setError("Could not record the rejection. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await resetDemoRequest();
      setStatus("new");
      setRejection(null);
      if (approval) {
        setPhase("sourcing_pending");
        setActingId(approval.approvers[0].id);
        setSourcing(null);
        setLaunch(null);
        setSentBack(null);
        setModalOpen(false);
        checkStarted.current = false;
        draftStarted.current = false;
        setCheckStatus("running");
        setDraftStatus("running");
        setPublished(null);
        setLaunchData(null);
        setStock((current) => (current ? { ...current, complete: false, doneLabel: null, canContinue: false } : current));
        setDraft((current) => (current ? { ...current, complete: false, doneLabel: null, canEdit: false, canSend: false } : current));
      }
    } catch {
      setError("Could not reset the demo. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const pending = status === "new";
  const steps: RailStep[] = phase ? launchRail(phase, modalOpen, stock?.complete ?? true) : view.steps;
  const stockScreen = phase === "stock_check" && stock !== null;
  const draftScreen = phase === "listing_draft" && draft !== null;
  const launchScreen = phase === "launch_pending" || phase === "sent_back" || phase === "launched";

  return (
    <div className="flex flex-1 flex-col" data-ops-console data-proposal-status={status}>
      <header className="flex h-20 items-center gap-5 border-b border-line-2 bg-surface px-12">
        <div className="flex items-center gap-3">
          <PelitaMark />
          <div>
            <div className="text-[30px] font-extrabold leading-none tracking-[-0.6px] text-ink">{view.brand.wordmark}</div>
            <div className="mt-[5px] text-[12px] font-extrabold leading-none tracking-[2.6px] text-primary">{view.brand.wordmarkSub}</div>
          </div>
        </div>
        <div aria-hidden="true" className="h-9 w-0.5 bg-line-2" />
        <h1 className="text-lg font-bold text-ink-2">{view.title}</h1>
        <div className="flex-1" />
        {other && (
          <button
            type="button"
            onClick={() => {
              setActingId(other.id);
              setError(null);
            }}
            disabled={busy}
            className="text-base font-semibold text-ink-3 underline underline-offset-4 disabled:opacity-60"
          >
            Switch to {other.name}
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          disabled={busy}
          className="text-base font-semibold text-ink-3 underline underline-offset-4 disabled:opacity-60"
        >
          Reset demo
        </button>
        <span
          data-demo-tag
          className="inline-flex items-center whitespace-nowrap rounded-sm border-2 border-dashed border-ink bg-surface px-3 py-[3px] text-base font-extrabold tracking-[0.6px] text-ink"
        >
          {view.demoTag}
        </span>
        <div className="flex items-center gap-3 font-bold">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-human text-[17px] font-extrabold text-white" aria-hidden="true">
            {person.initials}
          </span>
          <div className="leading-tight">
            {person.name}
            <div className="text-base font-semibold text-ink-3">{person.role}</div>
          </div>
        </div>
      </header>

      <Rail steps={steps} auditHref={AUDIT_PATH} />

      <main className="px-12 py-6">
        {approval && stockScreen && stock ? (
          <PelitaStockCheck
            data={stock}
            status={checkStatus}
            error={error}
            busy={busy}
            onRetry={() => void runCheck()}
            onContinue={continueFromCheck}
          />
        ) : approval && draftScreen && draft ? (
          <PelitaListingDraft
            data={draft}
            status={draftStatus}
            error={error}
            busy={busy}
            onRetry={() => void runDraft()}
            onEdit={editDraft}
            onSend={sendDraft}
          />
        ) : approval && launchScreen && actor ? (
          <PelitaLaunchApproval
            key={phase}
            data={launchData ?? approval.launch}
            phase={phase}
            actor={actor}
            sourcing={sourcing}
            launch={launch}
            sentBack={sentBack}
            published={published}
            busy={busy}
            error={error}
            onApprove={() => approve("launch")}
            onSendBack={sendBack}
          />
        ) : pending ? (
          <section
            aria-labelledby="gap-headline"
            className="rounded-xl border-2 border-[#c9bef5] bg-surface px-10 py-8 shadow-[inset_8px_0_0_var(--color-agent)]"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-agent">
                <SparkleIcon />
                {view.kicker}
              </div>
              <span className="rounded-full bg-agent-50 px-3.5 py-1 text-base font-bold text-agent">{view.detectedLabel}</span>
            </div>
            <h2 id="gap-headline" className="mt-3.5 text-h1 font-extrabold tracking-[-0.6px]">
              {view.headline}
            </h2>

            <div className="mt-[22px] grid grid-cols-[1fr_1fr_1fr_1.25fr] gap-5">
              <Stat value={formatCount(gap.searches)}>
                searches for “{gap.query}” in {gap.windowDays} days
              </Stat>
              <Stat value={formatCount(gap.matchingProductsInStock)} valueClass="text-danger">
                matching products in stock
              </Stat>
              <Stat value={`${gap.noPurchasePct}%`}>of those searches ended with no purchase</Stat>
              <Sparkline view={view} />
            </div>

            <div className="mt-6 grid grid-cols-[1.2fr_1fr] gap-7">
              <div className="flex items-center gap-6 rounded-[18px] bg-agent-50 px-7 py-[22px]">
                <div
                  className="flex h-[120px] w-[120px] flex-none items-center justify-center rounded-lg bg-surface [&>svg]:h-[100px] [&>svg]:w-[100px]"
                  dangerouslySetInnerHTML={{ __html: PELITA_ART[proposal.art] }}
                />
                <div>
                  <div className="text-base font-bold text-agent">PROPOSED</div>
                  <div className="text-h2 font-extrabold">{proposal.title}</div>
                  <div className="mt-1 text-base text-ink-2">{proposal.supplierLine}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Stat value={String(proposal.unitsPerWeek)}>units / week projected</Stat>
                <Stat value={`${proposal.grossMarginPct}%`}>gross margin (ex GST)</Stat>
                <Stat value={proposal.confidence} valueClass="text-success-text">
                  confidence · {proposal.confidencePct}%
                </Stat>
              </div>
            </div>

            <div className="mt-[26px] flex items-center justify-between">
              <p className="flex items-center gap-2 text-base font-semibold text-ink-3">
                Sources:
                {view.sources.map((source, i) => (
                  <span key={source} className="flex gap-2">
                    {i > 0 && <span aria-hidden="true">·</span>}
                    <b className="text-ink-2">{source}</b>
                  </span>
                ))}
              </p>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={reject}
                  disabled={busy}
                  className="h-14 px-4 text-lg font-bold text-ink underline underline-offset-4 disabled:opacity-60"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled
                  title="Editing arrives in a later step"
                  className="h-14 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink-3"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={!approval || busy}
                  onClick={() => {
                    setError(null);
                    setModalOpen(true);
                  }}
                  aria-describedby={approval ? undefined : "approval-note"}
                  aria-haspopup={approval ? "dialog" : undefined}
                  className={`h-14 rounded-md bg-human px-7 text-lg font-bold text-white ${approval ? "disabled:opacity-60" : "opacity-60"}`}
                >
                  Approve…
                </button>
              </div>
            </div>
            {!approval && (
              <p id="approval-note" className="mt-3 text-right text-base font-semibold text-ink-3">
                Two-person approval is not part of this screen yet.
              </p>
            )}
          </section>
        ) : (
          <section aria-labelledby="gap-outcome" className="rounded-xl border-2 border-line bg-surface px-10 py-8">
            <div className="text-base font-extrabold tracking-[0.2px] text-ink-3">{view.kicker}</div>
            <h2 id="gap-outcome" className="mt-2 text-h1 font-extrabold tracking-[-0.6px]">
              {status === "rejected" && rejection
                ? `Rejected by ${rejection.by}${rejection.atLabel ? ` · ${rejection.atLabel}` : ""}`
                : "Sourcing approved"}
            </h2>
            <p className="mt-2 text-lg text-ink-2">
              {proposal.title}. {status === "rejected" ? `Logged to the audit trail as ${gap.id}.` : "The agent can now check supplier and DC stock."}
            </p>
          </section>
        )}

        {error && !modalOpen && !launchScreen && !stockScreen && !draftScreen && (
          <p role="alert" className="mt-3 text-right text-base font-bold text-danger">
            {error}
          </p>
        )}
      </main>
      {approval && modalOpen && actor && (
        <PelitaApprovalModal
          data={approval.sourcing}
          actor={actor}
          busy={busy}
          error={error}
          onCancel={() => setModalOpen(false)}
          onApprove={() => approve("sourcing")}
        />
      )}
    </div>
  );
}
