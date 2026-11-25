import type { StockCell, StockCheckView } from "@/lib/demo/stock-check-view";
import { SparkleIcon, TickIcon } from "../pelita/PelitaIcons";

export type StockCheckStatus = "running" | "done" | "failed";

function DemoChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      data-demo-data
      className="inline-flex items-center whitespace-nowrap rounded-sm border-2 border-dashed border-ink bg-surface px-2 py-px text-base font-extrabold tracking-[0.6px] text-ink"
    >
      {children}
    </span>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <>
      <span aria-hidden="true" className="block h-[44px] w-28 animate-pulse rounded-md bg-line-2" />
      <span className="sr-only">{label}</span>
    </>
  );
}

function Cell({ cell, running, checking }: { cell: StockCell; running: boolean; checking: string }) {
  return (
    <div
      className={`rounded-lg border px-6 py-5 ${cell.emphasis && !running ? "border-[#9ad3b8] bg-success-50" : "border-line-2 bg-[#f8fafc]"}`}
    >
      <div className="mb-1.5 text-base font-bold text-ink-2">{cell.label}</div>
      {running ? (
        <Skeleton label={checking} />
      ) : (
        <>
          <div className="text-display font-extrabold leading-[1.1] tracking-[-1px]">{cell.value}</div>
          <div className="mt-1 text-base font-semibold text-ink-2">{cell.unit}</div>
        </>
      )}
    </div>
  );
}

function Panel({
  title,
  source,
  demoTag,
  children,
}: {
  title: string;
  source: string;
  demoTag: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[22px] font-extrabold leading-tight">{title}</h3>
          <p className="text-base font-semibold text-ink-3">{source}</p>
        </div>
        <DemoChip>{demoTag}</DemoChip>
      </div>
      <div className="grid grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

/**
 * Screen 03: the agent's supplier and ERP stock check. The check is the agent's
 * work, so it carries the violet stripe and sparkle. The result pill is green.
 */
export function PelitaStockCheck({
  data,
  status,
  error,
  busy,
  onRetry,
  onContinue,
}: {
  data: StockCheckView;
  status: StockCheckStatus;
  error: string | null;
  busy: boolean;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const running = status === "running";
  const done = status === "done";
  const po = data.erp.purchaseOrder;

  return (
    <section
      aria-labelledby="stock-title"
      aria-busy={running}
      data-stock-check
      data-stock-status={status}
      className="rounded-xl border-2 border-[#c9bef5] bg-surface px-10 py-8 shadow-[inset_8px_0_0_var(--color-agent)]"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-base font-extrabold tracking-[0.2px] text-agent">
          <SparkleIcon />
          {data.kicker}
        </div>
        {done && data.doneLabel ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-success-50 px-3.5 py-1 text-base font-bold text-success-text">
            <TickIcon size={18} />
            {data.doneLabel}
          </span>
        ) : status === "failed" ? (
          <span className="rounded-full border-2 border-warning-text bg-surface px-3.5 py-0.5 text-base font-bold text-warning-text">
            Supplier portal did not answer
          </span>
        ) : (
          <span role="status" className="rounded-full bg-agent-50 px-3.5 py-1 text-base font-bold text-agent">
            {data.checkingLabel}
          </span>
        )}
      </div>

      <h2 id="stock-title" className="mt-3.5 text-h1 font-extrabold tracking-[-0.6px]">
        {done ? data.title : "Checking whether we can sell it today."}
      </h2>
      <p className="mt-1.5 text-[20px] text-ink-2">
        {done ? data.sub : "The agent is reading the supplier portal, then our ERP."}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-7">
        <Panel title={data.supplier.title} source={data.supplier.source} demoTag={data.demoTag}>
          {data.supplier.cells.map((cell) => (
            <Cell key={cell.label} cell={cell} running={!done} checking={data.checkingLabel} />
          ))}
        </Panel>
        <Panel title={data.erp.title} source={data.erp.source} demoTag={data.demoTag}>
          {data.erp.cells.map((cell) => (
            <Cell key={cell.label} cell={cell} running={!done} checking={data.checkingLabel} />
          ))}
          <div className="col-span-2 flex items-center justify-between rounded-lg border border-line-2 bg-[#f8fafc] px-6 py-5">
            <div>
              <div className="text-base font-bold text-ink-2">{po.label}</div>
              {done ? <div className="text-h2 font-extrabold">{po.value}</div> : <Skeleton label={data.checkingLabel} />}
            </div>
            {done && (
              <span
                data-po-pill={po.underLimit ? "under" : "over"}
                className={
                  po.underLimit
                    ? "inline-flex items-center gap-2 rounded-full bg-success-50 px-3.5 py-1 text-base font-bold text-success-text"
                    : "inline-flex items-center gap-2 rounded-full border-2 border-warning-text bg-surface px-3.5 py-0.5 text-base font-bold text-warning-text"
                }
              >
                {po.underLimit && <TickIcon size={18} />}
                {po.pill}
              </span>
            )}
          </div>
        </Panel>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-base font-bold text-danger">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <p className="flex items-center gap-2 text-base font-semibold text-ink-3">
          Sources:
          {data.sources.map((source, i) => (
            <span key={source} className="flex gap-2">
              {i > 0 && <span aria-hidden="true">·</span>}
              <b className="text-ink-2">{source}</b>
            </span>
          ))}
        </p>
        {status === "failed" ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="h-14 rounded-md border-2 border-line bg-surface px-7 text-lg font-bold text-ink disabled:opacity-60"
          >
            Retry
          </button>
        ) : (
          <button
            type="button"
            onClick={onContinue}
            disabled={!done || !data.canContinue || busy}
            className="h-14 rounded-md bg-primary px-7 text-lg font-bold text-white disabled:opacity-50"
          >
            {data.continueLabel}
          </button>
        )}
      </div>
    </section>
  );
}
