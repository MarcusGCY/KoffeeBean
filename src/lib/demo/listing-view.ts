import { clockLabel } from "./ops-console";
import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { Scenario } from "./scenario";
import type { DemoAuditRow, DemoState } from "./state";
import { formatSgd } from "./storefront";

export const LISTING_KICKER = "DRAFTED BY SHELF AGENT · REVIEW BEFORE SENDING";
export const DRAFTING_LABEL = "Drafting the listing and checking claims…";
export const NOT_LIVE_LABEL = "Not live yet";

/** The human audit row that records a description edit. The new text follows the prefix after ": ". Its `ref` is the listing id. */
export const EDIT_ACTION_PREFIX = "Edited description";
/** The human audit row that sends the draft to approval 2. Its `ref` is the listing id. */
export const SEND_ACTION = "Sent listing and promo for approval";
export const EDIT_SOURCE = "Ops console";

export const DESCRIPTION_MAX = 280;

type ListingState = Pick<DemoState, "audit">;

/**
 * The fixture's own audit row for a step (its actor, action and source), so the
 * rows the agent writes read exactly as the designer's audit trail does.
 */
export function fixtureAuditRow(scenario: Scenario, predicate: (row: Scenario["audit"][number]) => boolean, what: string): Scenario["audit"][number] {
  const row = scenario.audit.find(predicate);
  if (!row) throw new Error(`Scenario has no audit row for ${what}`);
  return row;
}

export function claimsAuditRow(scenario: Scenario): Scenario["audit"][number] {
  return fixtureAuditRow(scenario, (row) => row.actorKind === "agent" && row.ref === scenario.claimsCheck.id, "the claims check");
}

export function draftAuditRow(scenario: Scenario): Scenario["audit"][number] {
  return fixtureAuditRow(scenario, (row) => row.actorKind === "agent" && row.ref === scenario.listing.id, "the listing draft");
}

export function publishAuditRow(scenario: Scenario): Scenario["audit"][number] {
  return fixtureAuditRow(scenario, (row) => row.actorKind === "system", "publishing");
}

export type RecordedDraft = { at: string; atLabel: string };

/**
 * A real listing draft exists once both of the agent's rows are on the audit
 * list: the claims check and the drafted listing. The runner writes them in one
 * request, so there is no half-done state to read.
 */
export function findListingDraft(scenario: Scenario, state: ListingState): RecordedDraft | null {
  const agent = (row: DemoAuditRow) => row.actorKind === "agent";
  const claims = state.audit.find((row) => agent(row) && row.ref === scenario.claimsCheck.id);
  const drafted = state.audit.find((row) => agent(row) && row.ref === scenario.listing.id);
  if (!claims || !drafted) return null;
  return { at: drafted.at, atLabel: clockLabel(drafted.at) };
}

export type RecordedEdit = { text: string; by: string; at: string; atLabel: string };

/** The latest human edit of the description, or null while the agent's own copy stands. */
export function findListingEdit(scenario: Scenario, state: ListingState): RecordedEdit | null {
  const marker = `${EDIT_ACTION_PREFIX}: `;
  const rows = state.audit.filter((row) => row.actorKind === "human" && row.ref === scenario.listing.id && row.action.startsWith(marker));
  const row = rows[rows.length - 1];
  if (!row) return null;
  return { text: row.action.slice(marker.length), by: row.actor.split(" · ")[0], at: row.at, atLabel: clockLabel(row.at) };
}

/** Collapses whitespace and checks the length. Returns null for text the listing cannot carry. */
export function normaliseDescription(text: string): string | null {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length === 0 || clean.length > DESCRIPTION_MAX ? null : clean;
}

/** The first removed claim the text brings back, or null when the claims check would still pass. */
export function findForbiddenClaim(scenario: Scenario, text: string): string | null {
  const lower = text.toLowerCase();
  const hit = scenario.claimsCheck.removed.find((r) => lower.includes(r.claim.toLowerCase()));
  return hit ? hit.claim : null;
}

/** The copy a shopper would read: the human's edit when there is one, otherwise the agent's. */
export function currentDescription(scenario: Scenario, state: ListingState): string {
  return findListingEdit(scenario, state)?.text ?? scenario.listing.description;
}

export type DraftField = { label: string; value: string; emphasis?: boolean };

export type ListingDraftView = {
  isDemo: true;
  demoTag: string;
  kicker: string;
  draftingLabel: string;
  complete: boolean;
  doneLabel: string | null;
  preview: {
    badge: string;
    art: PelitaArtKey;
    tag: string | null;
    ribbon: string;
    title: string;
    category: string;
    price: string;
    unitPrice: string;
    addLabel: string;
  };
  title: DraftField;
  description: { label: string; value: string; edited: { by: string; atLabel: string } | null; max: number };
  fields: DraftField[];
  claims: {
    id: string;
    label: string;
    detail: string;
    summary: string;
    removed: { claim: string; reason: string }[];
    oldText: string;
    newText: string;
    disclaimer: string;
  };
  editLabel: string;
  saveLabel: string;
  cancelLabel: string;
  sendLabel: string;
  /** Edit and Send need the agent's draft to exist first. */
  canEdit: boolean;
  canSend: boolean;
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Everything screen 04 renders, from the fixture and the persisted audit rows. */
export function listingDraftView(scenario: Scenario, state: ListingState): ListingDraftView {
  const { listing, promo, claimsCheck } = scenario;
  const product = scenario.catalogue.find((item) => item.id === listing.productId);
  if (!product || !isPelitaArtKey(product.art)) throw new Error(`Listing product ${listing.productId} has no art`);
  const draft = findListingDraft(scenario, state);
  const edit = findListingEdit(scenario, state);
  const category = product.subcategory ? `${product.category} › ${product.subcategory}` : product.category;
  const removed = claimsCheck.removed.map((r) => ({ claim: r.claim, reason: r.reason }));

  return {
    isDemo: true,
    demoTag: scenario.demoTag,
    kicker: LISTING_KICKER,
    draftingLabel: DRAFTING_LABEL,
    complete: draft !== null,
    doneLabel: draft ? `Drafted · ${draft.atLabel}` : null,
    preview: {
      badge: NOT_LIVE_LABEL,
      art: product.art,
      tag: product.tags.includes("New") ? "New" : null,
      ribbon: promo.ribbon,
      title: listing.title,
      category,
      price: formatSgd(listing.price),
      unitPrice: listing.unitPrice.replace("/", " per "),
      addLabel: "Add to cart",
    },
    title: { label: "Title", value: listing.title, emphasis: true },
    description: {
      label: "Description",
      value: edit?.text ?? listing.description,
      edited: edit ? { by: edit.by, atLabel: edit.atLabel } : null,
      max: DESCRIPTION_MAX,
    },
    fields: [
      { label: "Category", value: listing.category },
      { label: "Price", value: `${formatSgd(listing.price)} · ${listing.unitPrice}`, emphasis: true },
      { label: "Launch promo", value: promo.ribbon, emphasis: true },
      { label: "Runs", value: promo.runsLabel },
      { label: "Online stock", value: `${listing.onlineStock} units` },
      { label: "Margin at promo", value: `${promo.marginPct}% · floor is ${promo.marginFloorPct}%` },
    ],
    claims: {
      id: claimsCheck.id,
      label: `Claims check ${claimsCheck.status}`,
      detail: `${claimsCheck.ruleset} · ${plural(claimsCheck.removedCount, "claim")} removed`,
      summary: `${capitalise(claimsCheck.status)} · ${claimsCheck.id}`,
      removed,
      oldText: removed.map((r) => r.claim).join(", "),
      newText: claimsCheck.kept.join(", "),
      disclaimer: claimsCheck.disclaimer,
    },
    editLabel: "Edit",
    saveLabel: "Save edit",
    cancelLabel: "Cancel",
    sendLabel: "Send for approval →",
    canEdit: draft !== null,
    canSend: draft !== null,
  };
}
