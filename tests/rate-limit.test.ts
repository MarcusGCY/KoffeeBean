import { describe, expect, it } from "vitest";
import { FEEDBACK_LIMIT, FEEDBACK_WINDOW_MS, countRecentReports } from "@/lib/rate-limit";
import { reporterIdMarker } from "@/lib/shopper";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const USER = "auth0|shopper";

function report(minutesAgo: number, userId = USER) {
  return {
    body: `The tote is broken.\n\n${reporterIdMarker(userId)}`,
    createdAt: new Date(NOW - minutesAgo * 60 * 1000).toISOString(),
  };
}

describe("countRecentReports", () => {
  it("counts this shopper's reports inside the window and ignores older ones", () => {
    const records = [
      report(5),
      report(50),
      report(10, "auth0|someone-else"),
      report(FEEDBACK_WINDOW_MS / 60000 + 5),
    ];
    expect(countRecentReports(USER, records, NOW)).toBe(2);
    expect(countRecentReports(USER, Array.from({ length: FEEDBACK_LIMIT }, () => report(1)), NOW)).toBe(FEEDBACK_LIMIT);
  });
});
