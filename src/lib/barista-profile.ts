import products from "@/data/products.json";
import { normalizeLocation } from "./location-text";
import { DEFAULT_GRAMS_PER_DAY, estimateReorder, suggestNextBean, type NudgeOrder, type NudgeProduct } from "./reorder-nudge";
import { ROASTS, type Roast } from "./types";

/**
 * What Barista has learned about a shopper, in `app_metadata.barista_profile`.
 * Derived from retained orders only and made of enums and numbers: catalog product ids, a roast,
 * day and gram counts, dates. No names, emails, chat text or postcode. `district` is the 2-digit
 * postal district and only exists while the shopper has an active location consent.
 *
 * Auth0 caps all of `app_metadata` at 16 KB, so the profile is held to 2 KB, is rewritten inside the
 * same patch as the orders it came from, and is skipped (never the order) if the combined metadata
 * would not fit.
 */

export const PROFILE_VERSION = 1;
export const PROFILE_MAX_BYTES = 2048;
export const PROFILE_STALE_MS = 24 * 60 * 60 * 1000;
/** Auth0 allows 16 KB of `app_metadata`. Keep headroom so a later write still fits. */
export const META_BUDGET_BYTES = 15_000;
export const TOP_PRODUCTS = 5;
export const MIN_GRAMS_PER_DAY = 5;
export const MAX_GRAMS_PER_DAY = 60;
export const MAX_CADENCE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DISTRICT = /^\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fields the shopper may correct. A corrected field is kept when the profile is recomputed. */
export const EDITABLE_FIELDS = ["cadenceDays", "gramsPerDay", "preferredRoast"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type BaristaProfile = {
  v: typeof PROFILE_VERSION;
  updatedAt: string;
  /** Catalog product ids, most bought first. */
  topProducts: string[];
  /** Typical days between bean orders, or null until there are two. */
  cadenceDays: number | null;
  gramsPerDay: number;
  preferredRoast: Roast | null;
  district?: string;
  /** Date (YYYY-MM-DD) the latest bean order is estimated to run out. */
  nextDue?: string;
  /** Catalog id of a bean from `suggestNextBean`. */
  nextBean?: string;
  edited?: EditableField[];
  /** Personalization is off: nothing is learned or used until the shopper turns it back on. */
  off?: true;
};

const catalog = products as NudgeProduct[];
const catalogIds = new Set(catalog.map((product) => product.id));

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function profileBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function validCadence(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CADENCE_DAYS;
}

export function validGramsPerDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100;
}

export function validRoast(value: unknown): value is Roast {
  return typeof value === "string" && (ROASTS as readonly string[]).includes(value);
}

/** An empty profile. Also what "personalization off" and "reset" start from. */
export function emptyProfile(now: Date): BaristaProfile {
  return {
    v: PROFILE_VERSION,
    updatedAt: now.toISOString(),
    topProducts: [],
    cadenceDays: null,
    gramsPerDay: DEFAULT_GRAMS_PER_DAY,
    preferredRoast: null,
  };
}

/** Defensive read. Anything malformed, from another version, or over 2 KB is no profile, and gets recomputed. */
export function normalizeProfile(value: unknown): BaristaProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.v !== PROFILE_VERSION || !isIso(row.updatedAt)) return null;
  if (!Array.isArray(row.topProducts)) return null;
  const top: string[] = [];
  for (const id of row.topProducts) {
    if (typeof id === "string" && SAFE_ID.test(id) && catalogIds.has(id) && !top.includes(id)) top.push(id);
  }
  const cadenceDays = row.cadenceDays === null ? null : validCadence(row.cadenceDays) ? row.cadenceDays : undefined;
  if (cadenceDays === undefined) return null;
  if (typeof row.gramsPerDay !== "number" || !validGramsPerDay(row.gramsPerDay)) return null;
  const preferredRoast = row.preferredRoast === null ? null : validRoast(row.preferredRoast) ? row.preferredRoast : undefined;
  if (preferredRoast === undefined) return null;
  const profile: BaristaProfile = {
    v: PROFILE_VERSION,
    updatedAt: row.updatedAt,
    topProducts: top.slice(0, TOP_PRODUCTS),
    cadenceDays,
    gramsPerDay: row.gramsPerDay,
    preferredRoast,
  };
  if (typeof row.district === "string" && DISTRICT.test(row.district)) profile.district = row.district;
  if (typeof row.nextDue === "string" && DATE.test(row.nextDue) && !Number.isNaN(Date.parse(row.nextDue))) profile.nextDue = row.nextDue;
  if (typeof row.nextBean === "string" && catalogIds.has(row.nextBean)) profile.nextBean = row.nextBean;
  if (Array.isArray(row.edited)) {
    const edited = EDITABLE_FIELDS.filter((field) => (row.edited as unknown[]).includes(field));
    if (edited.length) profile.edited = [...edited];
  }
  if (row.off === true) profile.off = true;
  return profileBytes(profile) <= PROFILE_MAX_BYTES ? profile : null;
}

/** Drops the least important parts until the profile is within `PROFILE_MAX_BYTES`. */
export function fitProfile(profile: BaristaProfile): BaristaProfile {
  const next: BaristaProfile = { ...profile, topProducts: [...profile.topProducts] };
  while (profileBytes(next) > PROFILE_MAX_BYTES && next.topProducts.length > 0) next.topProducts.pop();
  if (profileBytes(next) > PROFILE_MAX_BYTES) delete next.nextBean;
  if (profileBytes(next) > PROFILE_MAX_BYTES) delete next.nextDue;
  if (profileBytes(next) > PROFILE_MAX_BYTES) delete next.edited;
  return next;
}

export function profileIsStale(profile: BaristaProfile, now: Date): boolean {
  const age = now.getTime() - Date.parse(profile.updatedAt);
  return !(age >= 0 && age <= PROFILE_STALE_MS);
}

type Bought = { id: string; qty: number; at: number };

function usableOrders(orders: readonly NudgeOrder[]): { order: NudgeOrder; at: number }[] {
  const rows: { order: NudgeOrder; at: number }[] = [];
  for (const order of orders) {
    if (!order || order.cancelledAt) continue;
    const at = Date.parse(order.createdAt);
    if (!Number.isNaN(at)) rows.push({ order, at });
  }
  return rows.sort((a, b) => a.at - b.at);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type ComputeOptions = {
  now: Date;
  /** Active location consent's district, or undefined. */
  district?: string | null;
  /** The stored profile, so corrected fields survive a recompute. */
  previous?: BaristaProfile | null;
};

/**
 * Pure: builds the profile from retained orders. Cancelled orders and unknown products are ignored.
 * `gramsPerDay` is learned from how fast earlier bean orders were followed by the next one and
 * feeds `estimateReorder`, so `nextDue` uses the shopper's own pace. `nextBean` is `suggestNextBean`'s pick.
 */
export function computeProfile(orders: readonly NudgeOrder[], options: ComputeOptions): BaristaProfile {
  const { now } = options;
  const byId = new Map(catalog.map((product) => [product.id, product]));
  const rows = usableOrders(orders);

  const counts = new Map<string, { qty: number; last: number }>();
  const roastQty = new Map<Roast, { qty: number; last: number }>();
  const beanOrders: { at: number; grams: number }[] = [];
  for (const { order, at } of rows) {
    let grams = 0;
    const lines: Bought[] = [];
    for (const item of order.items ?? []) {
      const product = byId.get(item.productId);
      if (!product || !Number.isInteger(item.qty) || item.qty < 1) continue;
      lines.push({ id: product.id, qty: item.qty, at });
      if (product.category === "beans" && product.attributes) {
        grams += product.attributes.grams * item.qty;
        const roast = roastQty.get(product.attributes.roast) ?? { qty: 0, last: 0 };
        roastQty.set(product.attributes.roast, { qty: roast.qty + item.qty, last: Math.max(roast.last, at) });
      }
    }
    for (const line of lines) {
      const seen = counts.get(line.id) ?? { qty: 0, last: 0 };
      counts.set(line.id, { qty: seen.qty + line.qty, last: Math.max(seen.last, at) });
    }
    if (grams > 0) beanOrders.push({ at, grams });
  }

  const topProducts = [...counts.entries()]
    .sort((a, b) => b[1].qty - a[1].qty || b[1].last - a[1].last || a[0].localeCompare(b[0]))
    .slice(0, TOP_PRODUCTS)
    .map(([id]) => id);

  const roast = [...roastQty.entries()].sort((a, b) => b[1].qty - a[1].qty || b[1].last - a[1].last)[0]?.[0] ?? null;

  const gaps: number[] = [];
  const paces: number[] = [];
  for (let i = 1; i < beanOrders.length; i++) {
    const days = Math.round(((beanOrders[i] as { at: number }).at - (beanOrders[i - 1] as { at: number }).at) / DAY_MS);
    if (days < 1) continue;
    gaps.push(days);
    paces.push((beanOrders[i - 1] as { grams: number }).grams / days);
  }
  const learnedCadence = gaps.length ? clamp(Math.round(median(gaps)), 1, MAX_CADENCE_DAYS) : null;
  const learnedPace = paces.length ? clamp(Math.round(median(paces)), MIN_GRAMS_PER_DAY, MAX_GRAMS_PER_DAY) : DEFAULT_GRAMS_PER_DAY;

  const edited = (options.previous?.edited ?? []).filter((field) => EDITABLE_FIELDS.includes(field));
  const keep = <K extends EditableField>(field: K, learned: BaristaProfile[K]): BaristaProfile[K] =>
    edited.includes(field) && options.previous ? options.previous[field] : learned;
  const cadenceDays = keep("cadenceDays", learnedCadence);
  const gramsPerDay = keep("gramsPerDay", learnedPace);
  const preferredRoast = keep("preferredRoast", roast);

  const profile: BaristaProfile = {
    v: PROFILE_VERSION,
    updatedAt: now.toISOString(),
    topProducts,
    cadenceDays,
    gramsPerDay,
    preferredRoast,
  };

  const estimate = estimateReorder(orders, catalog, { now, gramsPerDay });
  if (estimate) profile.nextDue = isoDate(Date.parse(estimate.orderedAt) + (estimate.daysSinceOrder + estimate.estimatedDaysLeft) * DAY_MS);
  const next = suggestNextBean(orders, catalog, [], { now });
  if (next) profile.nextBean = next.productId;
  if (options.district && DISTRICT.test(options.district)) profile.district = options.district;
  if (edited.length) profile.edited = [...edited];
  return fitProfile(profile);
}

/** True when the profile holds something learned or corrected, so an empty one is not worth storing. */
export function hasSignal(profile: BaristaProfile): boolean {
  return profile.topProducts.length > 0 || profile.preferredRoast !== null || profile.cadenceDays !== null || Boolean(profile.edited);
}

/**
 * The `barista_profile` key to add to a patch that already changes `orders`, or `{}` when the
 * profile should not be written: personalization is off, there is nothing to store, or
 * the combined metadata would pass the Auth0 budget. `otherPatch` is the rest of that patch.
 */
export function profilePatch(
  meta: Record<string, unknown>,
  orders: readonly NudgeOrder[],
  now: Date,
  otherPatch: Record<string, unknown> = {},
): { barista_profile?: BaristaProfile } {
  const previous = normalizeProfile(meta.barista_profile);
  if (previous?.off) return {};
  const computed = computeProfile(orders, {
    now,
    previous,
    district: normalizeLocation(meta.location)?.district ?? null,
  });
  if (!previous && !hasSignal(computed)) return {};
  const merged = { ...meta, ...otherPatch, barista_profile: computed };
  if (profileBytes(merged) > META_BUDGET_BYTES) return {};
  return { barista_profile: computed };
}

/** Applies a location change to an existing profile (add or remove `district`) without a recompute. */
export function districtPatch(
  meta: Record<string, unknown>,
  district: string | null,
): { barista_profile?: BaristaProfile } {
  const previous = normalizeProfile(meta.barista_profile);
  if (!previous || previous.off) return {};
  const next = { ...previous };
  if (district && DISTRICT.test(district)) next.district = district;
  else delete next.district;
  return { barista_profile: next };
}
