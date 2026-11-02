import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAT_HOUR_LIMIT } from "@/lib/limits";
import { takeChatSlot } from "@/lib/upstash";

describe("upstash chat quota", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("increments with EXPIRE before deciding, and parallel calls do not share a read", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
    let hour = CHAT_HOUR_LIMIT - 1;
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://redis.example/pipeline");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer redis-token");
        const commands = JSON.parse(String(init?.body)) as string[][];
        bodies.push(commands);
        expect(commands.some((command) => command[0] === "GET")).toBe(false);
        expect(commands[0]?.[0]).toBe("INCR");
        expect(commands[1]?.slice(0, 3)).toEqual(["EXPIRE", commands[0]?.[1], "3600"]);
        expect(commands[1]?.[3]).toBe("NX");
        hour += 1;
        const day = 1;
        return Response.json([
          { result: hour },
          { result: 1 },
          { result: 3600 },
          { result: day },
          { result: 1 },
          { result: 86400 },
        ]);
      }),
    );

    const [first, second] = await Promise.all([takeChatSlot("auth0|shopper"), takeChatSlot("auth0|shopper")]);
    const decisions = [first, second].sort((a, b) => Number(a.ok) - Number(b.ok));
    expect(decisions[0]).toEqual({ ok: false, retryAfterSec: 3600 });
    expect(decisions[1]).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
  });
});
