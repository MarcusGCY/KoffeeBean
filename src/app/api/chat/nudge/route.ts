import { NextResponse } from "next/server";
import { z } from "zod";
import { snoozeNudges } from "@/lib/agent-prefs";
import { nextNudge, nudgeLines } from "@/lib/nudge";
import { proposeAction } from "@/lib/pending-action";
import { dbFailure, readJson, requireShopper, requireWrite } from "@/lib/store-http";

const NO_STORE = { "cache-control": "private, no-store" };

/** The Barista proactive card for this chat session, or `{ nudge: null }`. At most one per session. */
export async function GET(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const session = new URL(req.url).searchParams.get("session");
  try {
    const result = await nextNudge(auth.userId, session);
    return NextResponse.json({ nudge: result.nudge }, { headers: NO_STORE });
  } catch (err) {
    return dbFailure(err);
  }
}

const Body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("accept"), choice: z.enum(["both", "reorder"]) }),
  z.strictObject({ action: z.literal("snooze") }),
]);

/**
 * `accept` signs one multi-add for the chosen chip (lines are re-derived here, never taken
 * from the client). `snooze` hides the nudge for seven days.
 */
export async function POST(req: Request) {
  const auth = await requireShopper();
  if (auth instanceof NextResponse) return auth;
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    if (parsed.data.action === "snooze") {
      return NextResponse.json({ ok: true, snoozeUntil: await snoozeNudges(auth.userId) });
    }
    const picked = await nudgeLines(auth.userId, parsed.data.choice);
    if ("error" in picked) {
      return NextResponse.json({ error: picked.error }, { status: picked.error === "paused" ? 403 : 404 });
    }
    const pending = await proposeAction(auth.userId, { op: "add_many", lines: picked.lines });
    if ("error" in pending) return NextResponse.json({ error: pending.error }, { status: 400 });
    return NextResponse.json({ actionId: pending.actionId, summary: pending.summary });
  } catch (err) {
    return dbFailure(err);
  }
}
