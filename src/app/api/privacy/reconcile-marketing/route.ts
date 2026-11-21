import { biDbConfigured, getBiSql } from "@/lib/bi-db";
import { biHashConfigured } from "@/lib/bi-hash";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { reconcileMarketing } from "@/lib/marketing-sync";
import { privacyJson, requirePrivacySecret } from "@/lib/privacy-auth";

/** Re-syncs BI marketing consent from Auth0. Idempotent; safe to call from a scheduler. POST only. */
export async function POST(req: Request) {
  const denied = requirePrivacySecret(req);
  if (denied) return denied;
  const sql = biDbConfigured() ? getBiSql() : null;
  if (!sql || !biHashConfigured() || !mgmtConfigured()) return privacyJson({ error: "unconfigured" }, 503);
  try {
    return privacyJson(await reconcileMarketing(sql));
  } catch (error) {
    console.error("[privacy] reconcile failed", error instanceof Error ? error.name : "unknown");
    return privacyJson({ error: "unavailable" }, 503);
  }
}
