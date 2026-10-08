import { recentReportRecords } from "./github";
import { reporterIdMarker } from "./shopper";

export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
export const FEEDBACK_LIMIT = 5;

export function countRecentReports(
  userId: string,
  records: { body: string; createdAt: string }[],
  now = Date.now(),
): number {
  const cutoff = now - FEEDBACK_WINDOW_MS;
  const needle = reporterIdMarker(userId);
  return records.filter((record) => {
    const created = Date.parse(record.createdAt);
    return Number.isFinite(created) && created >= cutoff && record.body.includes(needle);
  }).length;
}

/** True when this shopper has already filed FEEDBACK_LIMIT reports in the window. */
export async function tooManyFeedbackReports(userId: string, now = Date.now()): Promise<boolean> {
  const records = await recentReportRecords(new Date(now - FEEDBACK_WINDOW_MS).toISOString());
  return countRecentReports(userId, records, now) >= FEEDBACK_LIMIT;
}
