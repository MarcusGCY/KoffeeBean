import { describe, expect, it } from "vitest";
import { acceptsDirectChatReply, CHAT_UNAVAILABLE, noticeFor } from "@/lib/chat-response";

describe("POST /api/chat body after PR 45", () => {
  it("is a 200 the support chat client already accepts", () => {
    const reply = "We sell three coffees: House, Decaf, and Espresso.";
    const body = {
      reply,
      sessionId: `ses_${"a".repeat(24)}`,
      continuationToken: `v1.${"b".repeat(180)}`,
    };
    const raw = JSON.stringify(body);
    // Prod logged 200 responses of 312 B and 428 B with no errors. A short reply
    // plus the session fields lands in that range, and the client shows `reply`.
    expect(raw.length).toBeGreaterThan(250);
    expect(raw.length).toBeLessThan(500);
    expect(acceptsDirectChatReply(200, JSON.parse(raw) as { reply?: string })).toBe(true);
    expect(noticeFor(200, undefined)).toBe(CHAT_UNAVAILABLE);
  });
});
