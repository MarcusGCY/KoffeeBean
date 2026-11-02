import { takeChatSlot } from "./upstash";

export const CHAT_HOUR_LIMIT = 20;
export const CHAT_DAY_LIMIT = 60;
export const CHAT_HOUR_MS = 60 * 60 * 1000;
export const CHAT_DAY_MS = 24 * CHAT_HOUR_MS;

export const CHAT_RATE_LIMIT_MESSAGE = "Too many messages. Please try again in a little while.";

export type ChatLimitResult = { ok: boolean; retryAfterSec?: number };

/**
 * Per-user chat quota. `check` increments Upstash before the agent run.
 * INCR is atomic, so parallel requests cannot share one stale count.
 */
export interface ChatLimiter {
  check(userId: string): Promise<ChatLimitResult>;
}

export const chatLimiter: ChatLimiter = {
  check(userId: string) {
    return takeChatSlot(userId);
  },
};
