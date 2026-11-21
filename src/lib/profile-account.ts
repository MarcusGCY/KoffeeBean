import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import {
  EDITABLE_FIELDS,
  computeProfile,
  emptyProfile,
  hasSignal,
  normalizeProfile,
  profileIsStale,
  type BaristaProfile,
  type EditableField,
} from "./barista-profile";
import { getProduct } from "./cart";
import { normalizeLocation } from "./location-text";
import type { ProfileProduct, ProfileView } from "./profile-text";
import { retainedNudgeOrders } from "./store-meta";
import type { Roast } from "./types";

/**
 * The shopper's own view of `app_metadata.barista_profile`: read, correct, switch off, reset.
 * Every write touches only that one key for the signed-in shopper.
 */

export type ProfileEdit = {
  cadenceDays?: number | null;
  gramsPerDay?: number;
  preferredRoast?: Roast | null;
};

export type AccountChange =
  | { kind: "edit"; fields: EditableField[] }
  | { kind: "personalization"; on: boolean }
  | { kind: "reset" };

function product(id: string | undefined): ProfileProduct | null {
  const found = id ? getProduct(id) : undefined;
  return found ? { id: found.id, name: found.name } : null;
}

export function viewOf(profile: BaristaProfile | null): ProfileView {
  const off = profile?.off === true;
  const learned = profile !== null && !off && hasSignal(profile);
  return {
    personalization: off ? "off" : "on",
    hasData: learned,
    preferredRoast: learned ? profile.preferredRoast : null,
    cadenceDays: learned ? profile.cadenceDays : null,
    gramsPerDay: learned ? profile.gramsPerDay : null,
    topProducts: learned ? profile.topProducts.flatMap((id) => product(id) ?? []) : [],
    nextDue: learned ? (profile.nextDue ?? null) : null,
    nextBean: learned ? product(profile.nextBean) : null,
    edited: learned ? (profile.edited ?? []) : [],
    district: profile?.district ?? null,
    updatedAt: profile?.updatedAt ?? null,
  };
}

function meta(value: Record<string, unknown>) {
  return { orders: retainedNudgeOrders(value), district: normalizeLocation(value.location)?.district ?? null };
}

/** The current view. A missing or stale profile is rebuilt first, like the chat does. */
export async function readProfileView(userId: string, now = new Date()): Promise<ProfileView> {
  const current = await getAppMetadata(userId);
  let profile = normalizeProfile(current.barista_profile);
  if (!profile?.off && (!profile || profileIsStale(profile, now))) {
    const { orders, district } = meta(current);
    const computed = computeProfile(orders, { now, previous: profile, district });
    if (profile || hasSignal(computed)) {
      await patchAppMetadata(userId, { barista_profile: computed });
      profile = computed;
    }
  }
  const view = viewOf(profile);
  return { ...view, district: normalizeLocation(current.location)?.district ?? null };
}

async function save(userId: string, profile: BaristaProfile, location: unknown): Promise<ProfileView> {
  await patchAppMetadata(userId, { barista_profile: profile });
  return { ...viewOf(profile), district: normalizeLocation(location)?.district ?? null };
}

export type AccountResult = { view: ProfileView; change: AccountChange } | { error: "personalization_off" | "no_change" };

/** Corrects Barista's picture. A corrected field is kept when the profile is recomputed. */
export async function editProfile(userId: string, edit: ProfileEdit, now = new Date()): Promise<AccountResult> {
  const current = await getAppMetadata(userId);
  const stored = normalizeProfile(current.barista_profile);
  if (stored?.off) return { error: "personalization_off" };
  const { orders, district } = meta(current);
  const base = stored ?? computeProfile(orders, { now, district });
  const fields = EDITABLE_FIELDS.filter((field) => edit[field] !== undefined);
  const changed = fields.filter((field) => base[field] !== edit[field]);
  if (changed.length === 0) return { error: "no_change" };
  const edited = [...new Set([...(base.edited ?? []), ...fields])];
  const previous: BaristaProfile = { ...base, edited };
  for (const field of fields) Object.assign(previous, { [field]: edit[field] });
  const next = computeProfile(orders, { now, previous, district });
  return { view: await save(userId, next, current.location), change: { kind: "edit", fields: changed } };
}

/** Turns personalization off (everything learned is dropped and nothing is used) or back on (relearned from orders). */
export async function setPersonalization(userId: string, on: boolean, now = new Date()): Promise<AccountResult> {
  const current = await getAppMetadata(userId);
  const stored = normalizeProfile(current.barista_profile);
  if (on === !stored?.off) return { error: "no_change" };
  const next: BaristaProfile = on
    ? computeProfile(meta(current).orders, { now, district: meta(current).district })
    : { ...emptyProfile(now), off: true };
  return { view: await save(userId, next, current.location), change: { kind: "personalization", on } };
}

/** Clears corrections and relearns from retained orders. A shopper who turned personalization off stays off. */
export async function resetProfile(userId: string, now = new Date()): Promise<AccountResult> {
  const current = await getAppMetadata(userId);
  const stored = normalizeProfile(current.barista_profile);
  const next: BaristaProfile = stored?.off
    ? { ...emptyProfile(now), off: true }
    : computeProfile(meta(current).orders, { now, district: meta(current).district });
  return { view: await save(userId, next, current.location), change: { kind: "reset" } };
}

export function auditFor(change: AccountChange): { tool: string; summary: string } {
  if (change.kind === "edit") return { tool: "profile.edit", summary: `Corrected ${change.fields.join(", ")}`.slice(0, 80) };
  if (change.kind === "personalization") {
    return change.on
      ? { tool: "profile.personalization_on", summary: "Turned personalization on" }
      : { tool: "profile.personalization_off", summary: "Turned personalization off and cleared the profile" };
  }
  return { tool: "profile.reset", summary: "Reset the profile and relearned from orders" };
}
