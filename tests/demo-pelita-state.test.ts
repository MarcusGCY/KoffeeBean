import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEY_PREFIX,
  STATE_KEYS,
  STATE_KEY_NAMES,
  appendAudit,
  getDemoState,
  key,
  recordApproval,
  resetDemo,
  setListed,
  setStage,
  type StateKeyName,
} from "@/lib/demo/state";
import { evalFenced } from "./helpers/fake-redis-eval";

type Command = (string | number)[];

const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita": "no trailing colon, not ours",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};

let store: Map<string, string | string[]>;
let sent: Command[];

function fakeRedis(commands: Command[]): unknown[] {
  return commands.map((command) => {
    if (command[0] === "EVAL") return evalFenced(command, (key) => store.get(key) as string | undefined, (inner) => fakeRedis([inner])[0] as { result?: unknown; error?: string });
    sent.push(command);
    const [name, k, ...rest] = command as [string, string, ...(string | number)[]];
    switch (name) {
      case "GET":
        return { result: (store.get(k) as string | undefined) ?? null };
      case "SET":
        store.set(k, String(rest[0]));
        return { result: "OK" };
      case "DEL": {
        const had = store.delete(k);
        return { result: had ? 1 : 0 };
      }
      case "RPUSH": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        list.push(String(rest[0]));
        store.set(k, list);
        return { result: list.length };
      }
      case "LRANGE":
        return { result: (store.get(k) as string[] | undefined) ?? [] };
      default:
        return { error: `unsupported ${name}` };
    }
  });
}

beforeEach(() => {
  store = new Map(Object.entries(FOREIGN));
  sent = [];
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      Response.json(fakeRedis(JSON.parse(String(init?.body)) as Command[])),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("demo state keys", () => {
  it("builds every key under kb:demo:pelita:", () => {
    expect(KEY_PREFIX).toBe("kb:demo:pelita:");
    expect(STATE_KEY_NAMES.length).toBeGreaterThan(0);
    for (const name of STATE_KEY_NAMES) expect(key(name).startsWith("kb:demo:pelita:")).toBe(true);
    expect(STATE_KEYS).toEqual(STATE_KEY_NAMES.map(key));
  });

  it("refuses names that are not on the fixed list", () => {
    for (const name of ["", "other", "stage/../x", "kb:chat:h:u", "*"]) {
      expect(() => key(name as StateKeyName)).toThrow();
    }
  });

  it("only ever sends commands for prefixed keys, across every operation", async () => {
    await resetDemo();
    await setStage(3);
    await setListed(true);
    await recordApproval("sourcing", { approvalId: "APR-2051", approverId: "mei-ling-goh", at: "2026-11-25T09:03:35+08:00" });
    await appendAudit({ at: "2026-11-25T09:02:10+08:00", actorKind: "agent", actor: "Shelf Agent", action: "x", source: "y", ref: null });
    await getDemoState();
    expect(sent.length).toBeGreaterThan(0);
    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(String(target).startsWith("kb:demo:pelita:")).toBe(true);
      expect(STATE_KEYS).toContain(target);
    }
  });
});

describe("resetDemo", () => {
  it("deletes only the fixed key list, reseeds stage 0, and leaves foreign keys alone", async () => {
    await setStage(5);
    await setListed(true);
    await recordApproval("launch", { approvalId: "APR-2052", approverId: "arjun-menon", at: "2026-11-25T09:09:05+08:00" });
    await appendAudit({ at: "2026-11-25T09:09:21+08:00", actorKind: "system", actor: "Storefront", action: "Published", source: "CMS", ref: "LIVE" });
    sent = [];

    const state = await resetDemo();

    expect(state).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(sent).toEqual([
      ["DEL", "kb:demo:pelita:stage"],
      ["DEL", "kb:demo:pelita:approvals"],
      ["DEL", "kb:demo:pelita:audit"],
      ["DEL", "kb:demo:pelita:listed"],
      ["DEL", "kb:demo:pelita:claim:sourcing"],
      ["DEL", "kb:demo:pelita:claim:launch"],
      ["DEL", "kb:demo:pelita:opening"],
      ["DEL", "kb:demo:pelita:elapsed"],
      ["SET", "kb:demo:pelita:stage", "0"],
      ["SET", "kb:demo:pelita:listed", "0"],
      ["SET", "kb:demo:pelita:epoch", expect.stringMatching(/^[0-9a-f-]{36}$/)],
    ]);
    expect(sent.some((command) => command[0] === "DEL" && command[1] === "kb:demo:pelita:epoch")).toBe(false);
    const verbs = sent.map((command) => String(command[0]));
    expect(verbs.some((verb) => /SCAN|KEYS|FLUSH/.test(verb))).toBe(false);
    expect(sent.flat().some((part) => String(part).includes("*"))).toBe(false);

    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
  });
});

describe("demo state reads and writes", () => {
  it("reads an unseeded store as stage 0", async () => {
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
  });

  it("round-trips stage, approvals, audit rows and the listed flag", async () => {
    await setStage(4);
    await setListed(true);
    const first = { approvalId: "APR-2051", approverId: "mei-ling-goh", at: "2026-11-25T09:03:35+08:00" };
    const second = { approvalId: "APR-2052", approverId: "arjun-menon", at: "2026-11-25T09:09:05+08:00" };
    await recordApproval("sourcing", first);
    await recordApproval("launch", second);
    const row = { at: "2026-11-25T09:03:35+08:00", actorKind: "human" as const, actor: "Mei Ling Goh", action: "Approved sourcing", source: "Ops console", ref: "APR-2051" };
    await appendAudit(row);
    expect(await getDemoState()).toEqual({
      stage: 4,
      approvals: { sourcing: first, launch: second },
      audit: [row],
      listed: true,
    });
  });

  it("rejects a stage outside 0-7 without touching the store", async () => {
    for (const bad of [-1, 8, 1.5, Number.NaN]) {
      await expect(setStage(bad)).rejects.toThrow();
    }
    expect(sent).toEqual([]);
  });
});
