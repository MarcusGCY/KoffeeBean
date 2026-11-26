import { redisConfigured, redisPipeline, redisTransaction } from "../upstash";
import {
  LAUNCH_INDEX_KEY,
  LAUNCH_KEY_PREFIX,
  launchConfigSchema,
  launchKey,
  type LaunchConfig,
} from "./launch";

/**
 * Redis IO for Pelita launch configs. Keys sit beside the fixed demo state list:
 * `kb:demo:pelita:launch:<sku>` plus `kb:demo:pelita:launch:index`.
 * Listing also SCANs `kb:demo:pelita:launch:*` so a sku missing from the index is still found.
 * SCAN failures fall back to the index; they do not fail the read or the reset.
 */

function parseStored(value: unknown): LaunchConfig | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = launchConfigSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function skuFromKey(key: string): string | null {
  if (!key.startsWith(LAUNCH_KEY_PREFIX)) return null;
  const sku = key.slice(LAUNCH_KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(sku) || sku === "index") return null;
  return sku;
}

async function readIndex(): Promise<string[]> {
  const [value] = await redisPipeline([["GET", LAUNCH_INDEX_KEY]]);
  if (typeof value !== "string" || value === "") return [];
  try {
    const data = JSON.parse(value) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((item): item is string => typeof item === "string" && skuFromKey(`${LAUNCH_KEY_PREFIX}${item}`) === item);
  } catch {
    return [];
  }
}

/**
 * One SCAN page. A missing command or a down store returns null instead of throwing,
 * so reset can still delete the indexed keys with GET/SET/DEL.
 */
async function scanPage(cursor: string): Promise<{ cursor: string; keys: string[] } | null> {
  if (!redisConfigured()) return null;
  const base = (process.env.UPSTASH_REDIS_REST_URL ?? "").trim().replace(/\/$/, "");
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? "").trim();
  let response: Response;
  try {
    response = await fetch(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["SCAN", cursor, "MATCH", `${LAUNCH_KEY_PREFIX}*`, "COUNT", "200"]]),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body) || !body[0] || typeof body[0] !== "object") return null;
  const row = body[0] as { result?: unknown; error?: string };
  if (row.error) return null;
  const result = row.result;
  if (!Array.isArray(result) || result.length < 2 || !Array.isArray(result[1])) return null;
  return {
    cursor: String(result[0]),
    keys: result[1].filter((key): key is string => typeof key === "string"),
  };
}

async function scanKeys(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  for (let hop = 0; hop < 50; hop++) {
    const page = await scanPage(cursor);
    if (!page) break;
    found.push(...page.keys);
    if (page.cursor === "0" || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return found;
}

async function collectSkus(): Promise<Set<string>> {
  const skus = new Set(await readIndex());
  for (const key of await scanKeys()) {
    const sku = skuFromKey(key);
    if (sku) skus.add(sku);
  }
  return skus;
}

export async function saveLaunch(config: LaunchConfig): Promise<void> {
  const skus = await collectSkus();
  skus.add(config.sku);
  await redisTransaction([
    ["SET", launchKey(config.sku), JSON.stringify(config)],
    ["SET", LAUNCH_INDEX_KEY, JSON.stringify([...skus].sort())],
  ]);
}

export async function readLaunch(sku: string): Promise<LaunchConfig | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(sku) || sku === "index") return null;
  const [value] = await redisPipeline([["GET", launchKey(sku)]]);
  return parseStored(value);
}

export async function listLaunches(): Promise<LaunchConfig[]> {
  const skus = [...(await collectSkus())].sort();
  if (skus.length === 0) return [];
  const values = await redisPipeline(skus.map((sku) => ["GET", launchKey(sku)]));
  const configs: LaunchConfig[] = [];
  for (const value of values) {
    const config = parseStored(value);
    if (config) configs.push(config);
  }
  configs.sort((a, b) => a.sku.localeCompare(b.sku));
  return configs;
}

/** Sets status to live immediately. The stored go-live time is kept. */
export async function goLiveNow(sku: string): Promise<LaunchConfig | null> {
  const current = await readLaunch(sku);
  if (!current) return null;
  const next: LaunchConfig = { ...current, status: "live" };
  await redisPipeline([["SET", launchKey(sku), JSON.stringify(next)]]);
  return next;
}

/**
 * Deletes every `kb:demo:pelita:launch:*` key the index or a SCAN can see, including the index.
 * Called from the reset route after the fixed-key MULTI/EXEC so that transaction stays unchanged.
 */
export async function clearLaunchConfigs(): Promise<void> {
  const keys = new Set<string>([LAUNCH_INDEX_KEY]);
  for (const sku of await readIndex()) keys.add(launchKey(sku));
  for (const key of await scanKeys()) {
    if (key.startsWith(LAUNCH_KEY_PREFIX)) keys.add(key);
  }
  await redisPipeline([...keys].map((key) => ["DEL", key]));
}
