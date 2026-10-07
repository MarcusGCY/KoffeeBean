import { Agent, type RunResult } from "@cursor/sdk";
import { env, repo } from "./env";
import * as gh from "./github";
import { notifyFixCompleted } from "./notify";
import { describeRunError, reconcileRunResult } from "./run-status";

/** Launch a Cursor cloud agent that fixes the issue and opens a PR. */
export async function fixIssue(number: number) {
  const issue = await gh.getIssue(number);
  await gh.setLabels(number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED, gh.LABEL_FIXING]);

  const apiKey = env("CURSOR_API_KEY");
  const agent = await Agent.create({
    apiKey,
    name: `beanbox-fix-#${number}`,
    cloud: { repos: [{ url: repo().url }], autoCreatePR: true },
  });
  try {
    const run = await agent.send(
      [
        `Fix GitHub issue #${number}: ${issue.title}`,
        "",
        issue.body,
        "",
        "Rules: make the smallest change that fixes the root cause. Run `npm test` and make sure tests/cart.test.ts and tests/images.test.ts pass. productImageUrl for a bean id must return the path that exists under public/ (bean files are in public/images/beans/).",
        `Reference "Fixes #${number}" in the PR description.`,
      ].join("\n"),
    );
    console.log(`[fix] agent=${agent.agentId} run=${run.id}`);
    const result = await reconcileRunResult(run, apiKey);
    const pr = result.git?.branches.find((b) => b.prUrl)?.prUrl;
    const summary = fixSummary(result, pr);
    await gh.comment(number, summary);
    await notifyFixCompleted({
      number,
      title: issue.title,
      url: issue.url,
      status: result.status,
      prUrl: pr,
      summary,
    });
    await gh.setLabels(number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED]);
    return { status: result.status, prUrl: pr };
  } finally {
    agent.close();
  }
}

function fixSummary(result: RunResult, pr: string | undefined): string {
  if (result.status === "finished" && pr) return `Cursor opened a fix: ${pr}`;
  const detail = result.status === "finished" ? undefined : describeRunError(result.error);
  return `Cursor run ended with status \`${result.status}\`.${detail ? ` ${detail}.` : ""} ${pr ?? "No PR was created."}`;
}
