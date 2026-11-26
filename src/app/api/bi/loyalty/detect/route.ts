import { requireBiSecret, requireBiSql } from "@/lib/bi-read";
import { readLoyaltyReport, runYuuDetector, yuuWindowMinutes } from "@/lib/yuu/db";
import { yuuFailure, yuuJson } from "@/lib/yuu/http";

export const maxDuration = 30;

export async function POST(req: Request) {
  const denied = requireBiSecret(req);
  if (denied) return denied;
  const sql = requireBiSql();
  if (sql instanceof Response) return sql;
  let windowMinutes: number | undefined;
  try {
    const text = await req.text();
    if (text.trim()) {
      const body = JSON.parse(text) as { windowMinutes?: unknown };
      if (body.windowMinutes !== undefined) windowMinutes = yuuWindowMinutes(Number(body.windowMinutes));
    }
  } catch {
    return yuuJson({ error: "invalid_body" }, 400);
  }
  try {
    await runYuuDetector(windowMinutes, new Date(), { awaitWebhook: true });
    return yuuJson(await readLoyaltyReport(windowMinutes));
  } catch (error) {
    return yuuFailure(error, "[yuu] detect failed");
  }
}
