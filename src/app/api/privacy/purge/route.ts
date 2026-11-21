import { z } from "zod";
import { biDbConfigured, getBiSql } from "@/lib/bi-db";
import { biHashConfigured } from "@/lib/bi-hash";
import { mgmtConfigured } from "@/lib/auth0-mgmt";
import { privacyJson, requirePrivacySecret } from "@/lib/privacy-auth";
import { purgeProfiles } from "@/lib/retention";

const Body = z.strictObject({ dryRun: z.boolean().optional() });

/**
 * Deletes profile data past the retention period (`PRIVACY_RETENTION_MONTHS`, default 24). `{ "dryRun": true }`
 * only counts. Nothing calls this on a schedule from this repo. POST only.
 */
export async function POST(req: Request) {
  const denied = requirePrivacySecret(req);
  if (denied) return denied;
  let payload: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      return privacyJson({ error: "invalid_body" }, 400);
    }
  }
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return privacyJson({ error: "invalid_body" }, 400);
  const sql = biDbConfigured() ? getBiSql() : null;
  if (!sql || !biHashConfigured() || !mgmtConfigured()) return privacyJson({ error: "unconfigured" }, 503);
  try {
    return privacyJson(await purgeProfiles(sql, { dryRun: parsed.data.dryRun }));
  } catch (error) {
    console.error("[privacy] purge failed", error instanceof Error ? error.name : "unknown");
    return privacyJson({ error: "unavailable" }, 503);
  }
}
