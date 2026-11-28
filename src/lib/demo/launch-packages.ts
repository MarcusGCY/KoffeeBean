import type { DraftPush, LaunchConfig, LaunchSignalMeta } from "./launch";
import * as pl20055 from "./pl-20055-package";
import * as pl20068 from "./pl-20068-package";

/** Every approved built-in launch package. Redis can override any of them. */

export function builtinLaunches(): LaunchConfig[] {
  return [...pl20055.builtinLaunches(), ...pl20068.builtinLaunches()];
}

export function builtinLaunch(sku: string): LaunchConfig | null {
  return pl20055.builtinLaunch(sku) ?? pl20068.builtinLaunch(sku);
}

/** True for an approved package, including after Go live now flips the status. */
export function isApprovedPackage(value: LaunchConfig): boolean {
  return pl20055.isApprovedPl20055(value) || pl20068.isApprovedPl20068(value);
}

export function packagePriceNote(value: LaunchConfig): string | null {
  return pl20055.packagePriceNote(value) ?? pl20068.packagePriceNote(value);
}

export function scheduleExtras(value: LaunchConfig): {
  draftPush: DraftPush | null;
  priceNote: string | null;
  signal: LaunchSignalMeta | null;
} {
  if (pl20055.isApprovedPl20055(value)) return pl20055.scheduleExtras(value);
  return pl20068.scheduleExtras(value);
}
