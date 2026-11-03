import { CHAT_DAY_LIMIT, CHAT_HOUR_LIMIT } from "./limits";
import { StoreUnavailableError } from "./store-error";

/**
 * Upstash Redis REST. No SDK. Chat quotas use INCR + EXPIRE so two parallel
 * chats cannot both read the same count and both pass. One-time confirm
 * actions use SET NX and GETDEL.
 */

const HOUR_SEC = 60 * 60;
const DAY_SEC = 24 * HOUR_SEC;
const SAID_TTL_SEC = 30 * 60;
const SAID_CAP = 12;

type RedisRow = { result?: unknown; error?: string };

export function redisConfigured(): boolean {
  const env = process.env;
  return Boolean(env.UPSTASH_REDIS_REST_URL?.trim() && env.UPSTASH_REDIS_REST_TOKEN?.trim());
}

function endpoint(path: string): string {
  const base = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/$/, "");
  return `${base}${path}`;
}

export async function redisPipeline(commands: (string | number)[][]): Promise<unknown[]> {
  if (!redisConfigured()) throw new StoreUnavailableError();
  let response: Response;
  try {
    response = await fetch(endpoint("/pipeline"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${(process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
  } catch {
    throw new StoreUnavailableError();
  }
  if (!response.ok) {
    console.error("[redis] status", response.status);
    throw new StoreUnavailableError();
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body) || body.length !== commands.length) throw new StoreUnavailableError();
  return body.map((row) => {
    if (!row || typeof row !== "object") throw new StoreUnavailableError();
    const item = row as RedisRow;
    if (typeof item.error === "string" && item.error) {
      console.error("[redis] command failed");
      throw new StoreUnavailableError();
    }
    return item.result;
  });
}

async function redisCommand(command: (string | number)[]): Promise<unknown> {
  const [result] = await redisPipeline([command]);
  return result;
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new StoreUnavailableError();
}

function retry(ttl: unknown, fallback: number): number {
  return typeof ttl === "number" && ttl > 0 ? ttl : fallback;
}

/** Increments the hour and day counters before a chat turn is allowed to start. */
export async function takeChatSlot(userId: string): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const hourKey = `kb:chat:h:${userId}`;
  const dayKey = `kb:chat:d:${userId}`;
  const results = await redisPipeline([
    ["INCR", hourKey],
    ["EXPIRE", hourKey, String(HOUR_SEC), "NX"],
    ["TTL", hourKey],
    ["INCR", dayKey],
    ["EXPIRE", dayKey, String(DAY_SEC), "NX"],
    ["TTL", dayKey],
  ]);
  const hour = count(results[0]);
  const day = count(results[3]);
  if (hour > CHAT_HOUR_LIMIT) return { ok: false, retryAfterSec: retry(results[2], HOUR_SEC) };
  if (day > CHAT_DAY_LIMIT) return { ok: false, retryAfterSec: retry(results[5], DAY_SEC) };
  return { ok: true };
}

/** Shopper text from this chat, kept so a coupon must be one they typed. */
export async function rememberUserLines(userId: string, lines: string[]): Promise<void> {
  const kept = lines.map((line) => line.trim()).filter(Boolean).slice(-SAID_CAP);
  if (kept.length === 0) return;
  const key = `kb:said:${userId}`;
  await redisPipeline([
    ...kept.map((line) => ["RPUSH", key, line.slice(0, 500)]),
    ["LTRIM", key, String(-SAID_CAP), "-1"],
    ["EXPIRE", key, String(SAID_TTL_SEC)],
  ]);
}

export async function rememberedLines(userId: string): Promise<string[]> {
  const result = await redisCommand(["LRANGE", `kb:said:${userId}`, "0", "-1"]);
  if (!Array.isArray(result)) return [];
  return result.filter((item): item is string => typeof item === "string");
}

export async function issueNonce(jti: string, ttlSec: number): Promise<void> {
  const result = await redisCommand(["SET", `kb:act:${jti}`, "1", "EX", String(ttlSec), "NX"]);
  if (result !== "OK") throw new StoreUnavailableError();
}

/** Atomically takes the nonce. Only one caller gets true. */
export async function consumeNonce(jti: string): Promise<boolean> {
  return (await redisCommand(["GETDEL", `kb:act:${jti}`])) === "1";
}

/** Puts a spent nonce back when the write did not succeed. */
export async function rearmNonce(jti: string, ttlSec: number): Promise<void> {
  if (ttlSec < 1) return;
  await redisCommand(["SET", `kb:act:${jti}`, "1", "EX", String(ttlSec), "NX"]);
}

const TURN_TTL_SEC = 5 * 60;

export type StoredChatTurn = {
  userId: string;
  status: "pending" | "ready" | "error";
  reply?: string;
  pendingAction?: { actionId: string; summary: string };
  error?: string;
  httpStatus?: number;
};

function turnKey(userId: string, turnId: string): string {
  return `kb:chat:turn:${userId}:${turnId}`;
}

/** Reply for one chat turn. The key includes the shopper id so another user cannot read it. */
export async function saveChatTurn(userId: string, turnId: string, value: StoredChatTurn): Promise<void> {
  await redisCommand(["SET", turnKey(userId, turnId), JSON.stringify({ ...value, userId }), "EX", String(TURN_TTL_SEC)]);
}

export async function readChatTurn(userId: string, turnId: string): Promise<StoredChatTurn | null> {
  const raw = await redisCommand(["GET", turnKey(userId, turnId)]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredChatTurn;
    if (!parsed || parsed.userId !== userId) return null;
    return parsed;
  } catch {
    return null;
  }
}
