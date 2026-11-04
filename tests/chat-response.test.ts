import { describe, expect, it } from "vitest";
import { CHAT_UNAVAILABLE, followUps, noticeFor, takeSseEvents } from "@/lib/chat-response";

describe("support chat stream", () => {
  it("reads typed events and skips heartbeat comments", () => {
    const raw = [
      `event: status`,
      `data: {"text":"Looking that up…"}`,
      ``,
      `: heartbeat`,
      ``,
      `event: text`,
      `data: {"delta":"We sell three coffees."}`,
      ``,
      ``,
    ].join("\n");
    const taken = takeSseEvents(raw);
    expect(taken.events.map((event) => event.event)).toEqual(["status", "text"]);
    expect(taken.events[1]?.data).toContain("We sell three coffees.");
    expect(followUps("chat")).toHaveLength(3);
    expect(followUps("products")).toHaveLength(3);
    expect(noticeFor(503, "unavailable")).toBe(CHAT_UNAVAILABLE);
    expect(noticeFor(200, undefined)).toBe(CHAT_UNAVAILABLE);
  });
});
