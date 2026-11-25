import { PRESENTER_TTL_MS, presenterLink } from "../src/lib/demo/presenter";

/**
 * Prints a signed presenter link for the Pelita demo track.
 *
 *   npx tsx --env-file=.env.local scripts/demo-pelita-link.ts https://<preview-host> [hours]
 *
 * Reads APPROVAL_SECRET from the environment. The secret is never printed.
 */
function main(): void {
  const [base, hours] = process.argv.slice(2);
  const secret = process.env.APPROVAL_SECRET?.trim() ?? "";
  if (!base) {
    console.error("Usage: demo-pelita-link.ts <base-url> [hours]");
    process.exit(2);
  }
  if (!secret) {
    console.error("APPROVAL_SECRET is not set.");
    process.exit(1);
  }
  const ttlMs = hours ? Number(hours) * 60 * 60 * 1000 : PRESENTER_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    console.error("hours must be a positive number.");
    process.exit(2);
  }
  console.log(presenterLink(base, secret, Date.now(), ttlMs));
}

main();
