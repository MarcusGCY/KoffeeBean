import { after, NextResponse } from "next/server";
import * as gh from "@/lib/github";
import { triageFeedback } from "@/lib/triage";
import { requestReview } from "@/lib/notify";

export const maxDuration = 300;

export async function POST(req: Request) {
  const { message } = (await req.json()) as { message?: string };
  if (!message || message.trim().length < 5) {
    return NextResponse.json({ error: "Please describe the problem." }, { status: 400 });
  }
  const feedback = message.trim().slice(0, 2000);

  // Triage runs after the response so the shopper is not kept waiting.
  after(async () => {
    try {
      const open = await gh.listOpenFeedbackIssues();
      const d = await triageFeedback(feedback, open);
      if (d.action === "merge" && d.issueNumber) {
        await gh.appendReport(d.issueNumber, feedback);
        console.log(`[feedback] merged into #${d.issueNumber}`);
        return; // already in (or past) review
      }
      const issue = await gh.createIssue(d.title, `${d.body}\n\n---\n**Original report:**\n> ${feedback}`);
      console.log(`[feedback] created #${issue.number}`);
      await requestReview({ number: issue.number, title: d.title, url: issue.url, summary: d.body });
    } catch (e) {
      console.error("[feedback] pipeline failed", e);
    }
  });

  return NextResponse.json({ ok: true });
}
