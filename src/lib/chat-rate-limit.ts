import { getAppMetadata, patchAppMetadata } from "./auth0-mgmt";
import { CHAT_RATE_LIMIT_MESSAGE, normalizeLimits, takeSlot, type ChatLimits } from "./limits";

export const CHAT_HOUR_LIMIT = 20;
export const CHAT_DAY_LIMIT = 60;
export const CHAT_HOUR_MS = 60 * 60 * 1000;
export const CHAT_DAY_MS = 24 * CHAT_HOUR_MS;

export { CHAT_RATE_LIMIT_MESSAGE };

export type ChatLimitResult = { ok: boolean; retryAfterSec?: number };

/**
 * Per-user chat quota stored in Auth0 `app_metadata.chat_limits`.
 * `check` records a message when it is allowed.
 * A concurrent check can overwrite this key (last-write-wins).
 */
export interface ChatLimiter {
  check(userId: string): Promise<ChatLimitResult>;
}

async function storedLimits(userId: string): Promise<ChatLimits> {
  const meta = await getAppMetadata(userId);
  return normalizeLimits(meta.chat_limits);
}

export const chatLimiter: ChatLimiter = {
  async check(userId: string) {
    const decision = takeSlot(await storedLimits(userId), "messages", Date.now());
    if (decision.ok) {
      await patchAppMetadata(userId, { chat_limits: decision.limits });
      return { ok: true };
    }
    return { ok: false, retryAfterSec: decision.retryAfterSec };
  },
};
