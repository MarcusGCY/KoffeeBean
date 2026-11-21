import { biProfiles, parseProfilesQuery } from "@/lib/bi-profiles-read";
import { withdrawnHashes } from "@/lib/marketing-sync";
import { BiQueryError, biJson, requireBiSecret, requireBiSql } from "@/lib/bi-read";

export async function GET(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  const sql = requireBiSql();
  if (sql instanceof Response) return sql;
  try {
    const query = parseProfilesQuery(new URL(req.url).searchParams);
    return biJson(await biProfiles(sql, query, await withdrawnHashes()));
  } catch (error) {
    if (error instanceof BiQueryError) return biJson({ error: error.message }, 400);
    console.error("[bi] profiles read failed", error instanceof Error ? error.name : "unknown");
    return biJson({ error: "unavailable" }, 503);
  }
}
