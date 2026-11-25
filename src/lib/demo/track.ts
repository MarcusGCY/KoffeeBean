export type DemoTrack = "pelita";

/**
 * Server-side gate for the presenter-only demo track. Returns "pelita" only
 * when KB_DEMO_TRACK is exactly "pelita", including on Vercel production.
 * Unset, blank, or any other value returns null, and every demo route answers
 * 404. Production stays closed unless that variable is set on purpose.
 */
export function demoTrack(): DemoTrack | null {
  return process.env.KB_DEMO_TRACK === "pelita" ? "pelita" : null;
}
