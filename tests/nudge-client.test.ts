import { describe, expect, it } from "vitest";
import {
  NUDGE_SESSION_KEY,
  formatCountdown,
  markNudgeShown,
  nudgeAlreadyShown,
  nudgeSessionId,
  undoSecondsLeft,
} from "@/lib/nudge-client";
import { biSessionId } from "@/lib/bi-track";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("nudge session bookkeeping", () => {
  it("keeps one session id per tab session and it is safe for the server to store", () => {
    const storage = memoryStorage();
    const first = nudgeSessionId(storage, () => "11111111-2222-3333-4444-555555555555");
    expect(nudgeSessionId(storage, () => "other")).toBe(first);
    expect(storage.getItem(NUDGE_SESSION_KEY)).toBe(first);
    expect(biSessionId(first)).toBe(first);
  });

  it("shows the nudge once per session: not shown, then shown after markNudgeShown", () => {
    const storage = memoryStorage();
    expect(nudgeAlreadyShown(storage)).toBe(false);
    markNudgeShown(storage);
    expect(nudgeAlreadyShown(storage)).toBe(true);
  });

  it("survives blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(nudgeAlreadyShown(blocked)).toBe(false);
    expect(() => markNudgeShown(blocked)).not.toThrow();
    expect(nudgeSessionId(blocked, () => "x")).toBe("nudge_x");
  });
});

describe("undo countdown", () => {
  const until = "2026-11-21T08:10:00.000Z";

  it("counts whole seconds down to zero and never goes negative", () => {
    expect(undoSecondsLeft(until, Date.parse("2026-11-21T08:00:02.000Z"))).toBe(598);
    expect(undoSecondsLeft(until, Date.parse("2026-11-21T08:10:00.000Z"))).toBe(0);
    expect(undoSecondsLeft(until, Date.parse("2026-11-21T08:11:00.000Z"))).toBe(0);
    expect(undoSecondsLeft("not a date", 0)).toBe(0);
  });

  it("formats m:ss", () => {
    expect(formatCountdown(598)).toBe("9:58");
    expect(formatCountdown(600)).toBe("10:00");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});
