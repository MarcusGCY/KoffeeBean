import { demandGapView, type DemandGapView } from "./demand-gap";
import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { Scenario } from "./scenario";
import type { DemoState } from "./state";

export type ProposalStatus = "new" | "rejected" | "approved";

export type StepKind = "agent" | "human" | "system";
export type StepState = "done" | "current" | "upcoming";

export type RailStep = { n: number; label: string; kind: StepKind; state: StepState };

// Presentation choices for screen 01 (SPEC §10): the step names and who acts on each.
const STEPS: readonly { label: string; kind: StepKind }[] = [
  { label: "Detect", kind: "agent" },
  { label: "Approve sourcing", kind: "human" },
  { label: "Stock check", kind: "agent" },
  { label: "Draft listing", kind: "agent" },
  { label: "Approve launch", kind: "human" },
  { label: "Live", kind: "system" },
  { label: "Audit", kind: "system" },
];

export const CONSOLE_TITLE = "Ops console · New product launch";
export const KICKER = "SHELF AGENT · DEMAND-GAP PROPOSAL";

/** The audit action that marks a rejected proposal. Its `ref` is the proposal id. */
export const REJECT_ACTION_PREFIX = "Rejected proposal";

export type SparklineGeometry = {
  width: number;
  height: number;
  points: { x: number; y: number }[];
  last: { x: number; y: number };
};

/** Scales the series into the chart box. The y axis runs from 0 to `chartMax`. */
export function sparkline(values: readonly number[], chartMax: number, width = 520, height = 96, pad = 10): SparklineGeometry {
  const span = Math.max(values.length - 1, 1);
  const points = values.map((v, i) => ({
    x: round(pad + (i * (width - 2 * pad)) / span),
    y: round(height - (Math.min(Math.max(v, 0), chartMax) / chartMax) * height),
  }));
  return { width, height, points, last: points[points.length - 1] };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export type Rejection = { by: string; at: string; atLabel: string };

/**
 * The proposal is "rejected" once the audit list holds a rejection row for it,
 * and "approved" once the sourcing approval exists (written by the two-person
 * flow, which is not part of this screen). Otherwise it is new.
 */
export function proposalStatus(scenario: Scenario, state: Pick<DemoState, "approvals" | "audit">): ProposalStatus {
  if (state.approvals.sourcing) return "approved";
  return findRejection(scenario, state) ? "rejected" : "new";
}

export function findRejection(scenario: Scenario, state: Pick<DemoState, "audit">): Rejection | null {
  const row = state.audit.find((r) => r.ref === scenario.gap.id && r.action.startsWith(REJECT_ACTION_PREFIX));
  return row ? { by: row.actor, at: row.at, atLabel: clockLabel(row.at) } : null;
}

/** "09:02" in Singapore time, whatever zone the server runs in. */
export function clockLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Singapore" }).format(date);
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export type OpsConsoleView = {
  brand: { wordmark: string; wordmarkSub: string };
  demoTag: string;
  title: string;
  person: { name: string; initials: string; role: string };
  steps: RailStep[];
  kicker: string;
  detectedLabel: string;
  headline: string;
  gap: DemandGapView;
  chart: SparklineGeometry;
  proposal: {
    title: string;
    supplierLine: string;
    art: PelitaArtKey;
    unitsPerWeek: number;
    grossMarginPct: number;
    confidence: string;
    confidencePct: number;
  };
  sources: string[];
  status: ProposalStatus;
  rejection: Rejection | null;
  approverId: string;
};

/** Everything screen 01 renders, from the fixture and the persisted demo state. */
export function opsConsoleView(scenario: Scenario, state: Pick<DemoState, "approvals" | "audit">): OpsConsoleView {
  const gap = demandGapView(scenario);
  const { proposal } = scenario;
  const product = scenario.catalogue.find((item) => item.id === proposal.productId);
  if (!product || !isPelitaArtKey(product.art)) throw new Error(`Proposal product ${proposal.productId} has no art`);
  const person = scenario.approvers.find((a) => a.slot === 1);
  if (!person) throw new Error("Scenario has no first approver");
  const status = proposalStatus(scenario, state);
  const current = status === "approved" ? 2 : 1;

  return {
    brand: { wordmark: scenario.brand.wordmark, wordmarkSub: scenario.brand.wordmarkSub },
    demoTag: scenario.demoTag,
    title: CONSOLE_TITLE,
    person: { name: person.name, initials: person.initials, role: person.role },
    steps: STEPS.map((step, i) => ({
      n: i + 1,
      label: step.label,
      kind: step.kind,
      state: i + 1 < current ? "done" : i + 1 === current ? "current" : "upcoming",
    })),
    kicker: KICKER,
    detectedLabel: scenario.gap.detectedLabel,
    headline: scenario.gap.headline,
    gap,
    chart: sparkline(gap.searchesPerDay, gap.chartMax),
    proposal: {
      title: proposal.title,
      supplierLine: `Supplier: ${proposal.supplier}${proposal.supplierIsLocal ? " (local)" : ""}`,
      art: product.art,
      unitsPerWeek: proposal.forecast.unitsPerWeek,
      grossMarginPct: proposal.forecast.grossMarginPct,
      confidence: proposal.forecast.confidence,
      confidencePct: proposal.forecast.confidencePct,
    },
    sources: scenario.gap.sources,
    status,
    rejection: findRejection(scenario, state),
    approverId: person.id,
  };
}
