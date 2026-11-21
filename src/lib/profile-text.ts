/** "What Barista knows" view types and wording. Client-safe: no server imports. */
import type { EditableField } from "./barista-profile";
import type { Roast } from "./types";

export type ProfileProduct = { id: string; name: string };

export type ProfileView = {
  personalization: "on" | "off";
  /** False while Barista has learned nothing yet and nothing has been corrected. */
  hasData: boolean;
  preferredRoast: Roast | null;
  cadenceDays: number | null;
  gramsPerDay: number | null;
  topProducts: ProfileProduct[];
  /** YYYY-MM-DD */
  nextDue: string | null;
  nextBean: ProfileProduct | null;
  edited: EditableField[];
  /** The 2-digit district from location consent, never the postcode. */
  district: string | null;
  updatedAt: string | null;
};

export const ROAST_LABEL: Record<Roast, string> = {
  light: "Light",
  medium: "Medium",
  "medium-dark": "Medium-dark",
  dark: "Dark",
};

export function roastLabel(roast: Roast | null): string {
  return roast ? ROAST_LABEL[roast] : "Not sure yet";
}

export function cadenceLabel(days: number | null): string {
  return days === null ? "Not sure yet" : `About every ${days} ${days === 1 ? "day" : "days"}`;
}

export function pace(grams: number | null): string {
  return grams === null ? "Not sure yet" : `About ${grams} g a day`;
}

export function dueLabel(date: string | null): string {
  if (!date) return "Not sure yet";
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? "Not sure yet"
    : parsed.toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
