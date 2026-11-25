import { requireBiSecret, requireBiSql } from "@/lib/bi-read";
import { readLoyaltyReport, yuuWindowMinutes } from "@/lib/yuu/db";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";

export async function GET(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  const sql = requireBiSql();
  if (sql instanceof Response) return sql;
  try {
    const params = new URL(req.url).searchParams;
    const raw = params.get("window_minutes");
    const windowMinutes = raw == null || raw.trim() === "" ? undefined : yuuWindowMinutes(Number(raw));
    return yuuJson(await readLoyaltyReport(windowMinutes));
  } catch (error) {
    return yuuFailure(error, "[yuu] loyalty read failed");
  }
}
