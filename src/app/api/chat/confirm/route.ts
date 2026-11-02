import { after, NextResponse } from "next/server";
import { z } from "zod";
import { fileFeedback } from "@/lib/file-feedback";
import { commitAction } from "@/lib/pending-action";
import { getShopper } from "@/lib/shopper";
import { readJson, requireWrite } from "@/lib/store-http";
import { StoreUnavailableError } from "@/lib/store-error";

export const maxDuration = 300;

const Body = z.strictObject({
  actionId: z.string().min(1).max(8000),
});

/** Verifies the signed action for this shopper and performs it once. */
export async function POST(req: Request) {
  const shopper = await getShopper();
  if (!shopper) return NextResponse.json({ error: "Sign in to confirm." }, { status: 401 });
  const blocked = requireWrite(req);
  if (blocked) return blocked;
  const payload = await readJson(req);
  if (payload instanceof NextResponse) return payload;
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = await commitAction(shopper.id, parsed.data.actionId, shopper);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: result.message },
        {
          status: result.status,
          headers: result.status === 429 ? { "retry-after": "60" } : undefined,
        },
      );
    }
    if (result.report) {
      const { feedback, reportedBy } = result.report;
      after(async () => {
        try {
          await fileFeedback(feedback, reportedBy);
        } catch (err) {
          console.error("[confirm] feedback failed", err instanceof Error ? err.name : "Error");
        }
      });
    }
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
    }
    console.error("[confirm] failed", err instanceof Error ? err.name : "Error");
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
}
