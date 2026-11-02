import { NextResponse } from "next/server";
import { agentUserId } from "@/lib/agent-auth";
import { loadFaq } from "@/lib/faq";
import { recordAudit } from "@/lib/store-meta";
import { dbFailure } from "@/lib/store-http";

export async function GET(req: Request) {
  const userId = agentUserId(req);
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const faq = loadFaq();
    await recordAudit(userId, {
      ts: new Date().toISOString(),
      tool: "faq_answer",
      summary: "Returned the approved FAQ",
      outcome: "ok",
    });
    return NextResponse.json({ faq });
  } catch (err) {
    return dbFailure(err);
  }
}
