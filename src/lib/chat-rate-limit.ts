export const CHAT_HOUR_LIMIT = 20;
export const CHAT_DAY_LIMIT = 60;
export const CHAT_HOUR_MS = 60 * 60 * 1000;
export const CHAT_DAY_MS = 24 * CHAT_HOUR_MS;

export const CHAT_RATE_LIMIT_MESSAGE =
  "Too many messages. Please try again in a little while.";

export type ChatLimitResult = { ok: boolean; retryAfterSec?: number };

/**
 * Per-user chat quota. `check` records a message when it is allowed.
 * Replace `chatLimiter` with an Upstash-backed implementation of this
 * interface later; callers should not depend on process memory.
 */
export interface ChatLimiter {
  check(userId: string): Promise<ChatLimitResult>;
}

/**
 * Best-effort in-memory limiter. Counts live on this server instance only
 * and reset when the process cold-starts. They are not shared across Vercel
 * isolates, so a shopper can exceed the limit when requests land on
 * different instances. Upstash can replace this later.
 */
export function createMemoryChatLimiter(now: () => number = Date.now): ChatLimiter {
  const hits = new Map<string, number[]>();

  return {
    async check(userId: string) {
      const at = now();
      const day = (hits.get(userId) ?? []).filter((ts) => at - ts < CHAT_DAY_MS);
      const hour = day.filter((ts) => at - ts < CHAT_HOUR_MS);

      if (hour.length >= CHAT_HOUR_LIMIT) {
        hits.set(userId, day);
        return { ok: false, retryAfterSec: retryAfter(hour[0], CHAT_HOUR_MS, at) };
      }
      if (day.length >= CHAT_DAY_LIMIT) {
        hits.set(userId, day);
        return { ok: false, retryAfterSec: retryAfter(day[0], CHAT_DAY_MS, at) };
      }

      day.push(at);
      hits.set(userId, day);
      return { ok: true };
    },
  };
}

function retryAfter(oldest: number | undefined, windowMs: number, at: number): number {
  if (oldest === undefined) return Math.ceil(windowMs / 1000);
  return Math.max(1, Math.ceil((windowMs - (at - oldest)) / 1000));
}

export const chatLimiter: ChatLimiter = createMemoryChatLimiter();
