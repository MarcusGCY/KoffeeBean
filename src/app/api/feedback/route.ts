import { after, NextResponse } from "next/server";
import { fileFeedback } from "@/lib/file-feedback";
import { tooManyFeedbackReports } from "@/lib/rate-limit";
import { getShopper, reporterBlock } from "@/lib/shopper";

// Hobby Fluid compute allows 300s, including work scheduled with after().
export const maxDuration = 300;

export async function POST(req: Request) {
  const shopper = await getShopper();
  if (!shopper) {
    return NextResponse.json({ error: "Sign in to send feedback." }, { status: 401 });
  }

  const { message } = (await req.json()) as { message?: string };
  if (!message || message.trim().length < 5) {
    return NextResponse.json({ error: "Please describe the problem." }, { status: 400 });
  }
  const feedback = message.trim().slice(0, 2000);
  const reportedBy = reporterBlock(shopper);

  try {
    if (await tooManyFeedbackReports(shopper.id)) {
      return NextResponse.json(
        { error: "Too many reports. Try again in a little while." },
        { status: 429 },
      );
    }
  } catch (e) {
    console.error("[feedback] rate limit check failed", e);
    return NextResponse.json({ error: "Could not accept feedback right now." }, { status: 503 });
  }

  // Triage runs after the response so the shopper is not kept waiting.
  // On Vercel the callback must finish inside maxDuration. Triage polls
  // only for that budget, then the server runs the reproduction test.
  after(async () => {
    try {
      await fileFeedback(feedback, reportedBy);
    } catch (e) {
      console.error("[feedback] pipeline failed", e);
    }
  });

  return NextResponse.json({ ok: true });
}
