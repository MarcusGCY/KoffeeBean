/** Browser-side bookkeeping for the once-per-session Barista nudge. Pure so it can be tested without a DOM. */

export const NUDGE_SESSION_KEY = "beanbox-nudge-session";
export const NUDGE_SHOWN_KEY = "beanbox-nudge-shown";

type Store = Pick<Storage, "getItem" | "setItem">;

function read(storage: Store, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: Store, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage can be blocked. The server still enforces one nudge per session id.
  }
}

/** Stable id for this browser tab session. It is what the server stores as `lastNudgeSession`. */
export function nudgeSessionId(storage: Store, makeId: () => string = () => crypto.randomUUID()): string {
  const existing = read(storage, NUDGE_SESSION_KEY);
  if (existing) return existing;
  const id = `nudge_${makeId()}`;
  write(storage, NUDGE_SESSION_KEY, id);
  return id;
}

export function nudgeAlreadyShown(storage: Store): boolean {
  return read(storage, NUDGE_SHOWN_KEY) === "1";
}

export function markNudgeShown(storage: Store): void {
  write(storage, NUDGE_SHOWN_KEY, "1");
}

/** Whole seconds left in the undo window, never negative. */
export function undoSecondsLeft(undoUntilIso: string, nowMs: number): number {
  const until = new Date(undoUntilIso).getTime();
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
