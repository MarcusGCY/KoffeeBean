import { approvalView, launchPhase, type ApprovalView } from "./approval-view";
import {
  EDIT_ACTION_PREFIX,
  EDIT_SOURCE,
  SEND_ACTION,
  claimsAuditRow,
  currentDescription,
  draftAuditRow,
  findForbiddenClaim,
  findListingDraft,
  listingDraftView,
  normaliseDescription,
  type ListingDraftView,
} from "./listing-view";
import type { Scenario } from "./scenario";
import { LAUNCH_APPROVAL_STAGE, appendAuditRows, appendAuditRowsAndSetStage, getDemoState, type DemoAuditRow } from "./state";
import { defaultStockCheckDeps, type StockCheckDeps } from "./stock-check";

export type ClaimsCheck = {
  isDemo: true;
  id: string;
  ruleset: string;
  status: Scenario["claimsCheck"]["status"];
  removed: { claim: string; reason: string }[];
};

/** The delay, clock and claims check are injected, so tests pass an instant `wait`. The default is a mock that reads the fixture only. */
export type ListingDeps = Pick<StockCheckDeps, "wait" | "delayMs" | "now"> & {
  claims: (scenario: Scenario, deps: Pick<StockCheckDeps, "wait" | "delayMs">) => Promise<ClaimsCheck>;
};

/** Mock claims check: the fixture's rules result after a realistic pause. Nothing here reaches an outside host. */
export async function mockClaimsCheck(scenario: Scenario, deps: Pick<StockCheckDeps, "wait" | "delayMs">): Promise<ClaimsCheck> {
  await deps.wait(deps.delayMs());
  const { claimsCheck } = scenario;
  return {
    isDemo: true,
    id: claimsCheck.id,
    ruleset: claimsCheck.ruleset,
    status: claimsCheck.status,
    removed: claimsCheck.removed.map((r) => ({ claim: r.claim, reason: r.reason })),
  };
}

export const defaultListingDeps: ListingDeps = {
  wait: defaultStockCheckDeps.wait,
  delayMs: defaultStockCheckDeps.delayMs,
  now: defaultStockCheckDeps.now,
  claims: mockClaimsCheck,
};

let configured: ListingDeps = defaultListingDeps;

/** Test seam for the API route, which has no other way to take dependencies. Pass null to restore the defaults. */
export function setListingDeps(deps: Partial<ListingDeps> | null): void {
  configured = deps ? { ...defaultListingDeps, ...deps } : defaultListingDeps;
}

export type ListingRefusal =
  | "unknown_approver"
  | "sourcing_required"
  | "proposal_rejected"
  | "sent_back"
  | "already_launched"
  | "stock_check_required"
  | "draft_required"
  | "already_sent"
  | "invalid_description"
  | "claim_not_allowed"
  | "claims_failed";

export type ListingResult =
  | { ok: true; changed: boolean; phase: "listing_draft" | "launch_pending"; draft: ListingDraftView; launch: ApprovalView["launch"] }
  | { ok: false; reason: ListingRefusal };

type ListingState = Awaited<ReturnType<typeof getDemoState>>;

/** The draft screen and the approval-2 screen both read the same persisted rows, so one result carries both. */
function done(scenario: Scenario, changed: boolean, phase: "listing_draft" | "launch_pending", state: ListingState): ListingResult {
  return { ok: true, changed, phase, draft: listingDraftView(scenario, state), launch: approvalView(scenario, state).launch };
}

const refuse = (reason: ListingRefusal): { ok: false; reason: ListingRefusal } => ({ ok: false, reason });

/** Why the draft cannot be worked on in this phase, or null when it can. */
function blocked(phase: ReturnType<typeof launchPhase>): ListingRefusal | null {
  switch (phase) {
    case "sourcing_pending":
      return "sourcing_required";
    case "rejected":
      return "proposal_rejected";
    case "sent_back":
      return "sent_back";
    case "launched":
      return "already_launched";
    case "stock_check":
      return "stock_check_required";
    default:
      return null;
  }
}

function humanActor(scenario: Scenario, approverId: string): string | null {
  const person = scenario.approvers.find((a) => a.id === approverId);
  return person ? `${person.name} · ${person.role}` : null;
}

function humanRow(actor: string, at: Date, action: string, ref: string): DemoAuditRow {
  return { at: at.toISOString(), actorKind: "human", actor, action, source: EDIT_SOURCE, ref };
}

/**
 * Screen 04. After the stock check the agent runs the claims check (a mock, after
 * its own delay) and drafts the listing and promo. The two agent audit rows that
 * make the draft real are written together once the claims check has passed. A
 * draft that already exists is returned as it is and never written twice.
 */
export async function runListingDraft(scenario: Scenario, deps: ListingDeps = configured): Promise<ListingResult> {
  const before = await getDemoState();
  const phase = launchPhase(scenario, before);
  const stop = blocked(phase);
  if (stop) return refuse(stop);
  if (findListingDraft(scenario, before)) {
    return done(scenario, false, phase === "launch_pending" ? "launch_pending" : "listing_draft", before);
  }

  const claims = await deps.claims(scenario, deps);
  if (claims.status !== "passed" || findForbiddenClaim(scenario, scenario.listing.description) !== null) return refuse("claims_failed");

  // Another request may have finished the same draft while this one waited.
  const latest = await getDemoState();
  if (!findListingDraft(scenario, latest)) {
    const at = deps.now().toISOString();
    await appendAuditRows([
      { ...claimsAuditRow(scenario), at },
      { ...draftAuditRow(scenario), at },
    ]);
  }
  return done(scenario, true, "listing_draft", await getDemoState());
}

/**
 * Edit on the draft: a human changes the description. The claims check runs again on
 * the new text, and a claim it removed cannot come back. The edit is one human audit
 * row, so resetDemo() restores the agent's copy.
 */
export async function editListing(
  scenario: Scenario,
  input: { approverId: string; description: string },
  now: Date = new Date(),
): Promise<ListingResult> {
  const actor = humanActor(scenario, input.approverId);
  if (!actor) return refuse("unknown_approver");
  const state = await getDemoState();
  const phase = launchPhase(scenario, state);
  const stop = blocked(phase);
  if (stop) return refuse(stop);
  if (phase === "launch_pending") return refuse("already_sent");
  if (!findListingDraft(scenario, state)) return refuse("draft_required");

  const text = typeof input.description === "string" ? normaliseDescription(input.description) : null;
  if (text === null) return refuse("invalid_description");
  if (findForbiddenClaim(scenario, text) !== null) return refuse("claim_not_allowed");
  if (text === currentDescription(scenario, state)) {
    return done(scenario, false, "listing_draft", state);
  }

  await appendAuditRows([humanRow(actor, now, `${EDIT_ACTION_PREFIX}: ${text}`, scenario.listing.id)]);
  return done(scenario, true, "listing_draft", await getDemoState());
}

/**
 * "Send for approval →": records who sent the draft and moves to screen 05, which is
 * the only way approval 2 opens. Sending twice is a no-op.
 */
export async function sendForApproval(scenario: Scenario, input: { approverId: string }, now: Date = new Date()): Promise<ListingResult> {
  const actor = humanActor(scenario, input.approverId);
  if (!actor) return refuse("unknown_approver");
  const state = await getDemoState();
  const phase = launchPhase(scenario, state);
  const stop = blocked(phase);
  if (stop) return refuse(stop);
  if (phase === "launch_pending") {
    return done(scenario, false, "launch_pending", state);
  }
  if (!findListingDraft(scenario, state)) return refuse("draft_required");

  await appendAuditRowsAndSetStage([humanRow(actor, now, SEND_ACTION, scenario.listing.id)], LAUNCH_APPROVAL_STAGE);
  return done(scenario, true, "launch_pending", await getDemoState());
}
