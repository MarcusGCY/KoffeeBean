export type DemoTrack = "pelita";

/**
 * Server-side gate for the presenter-only demo track. Returns "pelita" only
 * when KB_DEMO_TRACK is exactly "pelita" and the deployment is not Vercel
 * production. Everywhere else (including prod, where the variable is unset)
 * it returns null and every demo route answers 404.
 */
export function demoTrack(): DemoTrack | null {
  if (process.env.VERCEL_ENV === "production") return null;
  return process.env.KB_DEMO_TRACK === "pelita" ? "pelita" : null;
}
