import * as gh from "./github";
import { requestReview } from "./notify";
import { cannotReproduceBody, reproduceOnMain, reproducedIssueBody } from "./reproduce";
import { triageFeedback } from "./triage";

/**
 * Triage a report. A new issue with `awaiting-review` is opened only when
 * the reproduction test fails on main. Otherwise the report is closed as
 * `cannot-reproduce` and review is not requested.
 */
export async function fileFeedback(feedback: string, reportedBy: string): Promise<void> {
  const open = await gh.listOpenFeedbackIssues();
  const decision = await triageFeedback(feedback, open);
  if (decision.action === "merge" && decision.issueNumber) {
    await gh.appendReport(decision.issueNumber, `${feedback}\n\n${reportedBy}`);
    console.log(`[feedback] merged into #${decision.issueNumber}`);
    return;
  }

  const repro = await reproduceOnMain(decision.testPath, decision.branch);
  if (!repro.reproduced) {
    await gh.ensureLabel(
      gh.LABEL_CANNOT_REPRODUCE,
      "ededed",
      "Triage could not reproduce this report on main",
    );
    const issue = await gh.createIssue(
      decision.title,
      cannotReproduceBody({
        summary: decision.body,
        feedback,
        reportedBy,
        reason: repro.reason,
        testPath: repro.testPath,
        branch: repro.branch,
      }),
      [gh.FEEDBACK_LABEL, gh.LABEL_CANNOT_REPRODUCE],
    );
    await gh.closeIssue(issue.number);
    console.log(`[feedback] cannot reproduce #${issue.number} (${repro.reason})`);
    return;
  }

  const issue = await gh.createIssue(
    decision.title,
    reproducedIssueBody({
      summary: decision.body,
      testPath: repro.testPath,
      branch: repro.branch,
      output: repro.output,
      feedback,
      reportedBy,
    }),
  );
  console.log(`[feedback] created #${issue.number}`);
  await requestReview({
    number: issue.number,
    title: decision.title,
    url: issue.url,
    summary: decision.body,
  });
}
