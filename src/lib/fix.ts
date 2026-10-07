import { Agent } from "@cursor/sdk";
import { env, repo } from "./env";
import * as gh from "./github";

/** Launch a Cursor cloud agent that fixes the issue and opens a PR. */
export async function fixIssue(number: number) {
  const issue = await gh.getIssue(number);
  await gh.setLabels(number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED, gh.LABEL_FIXING]);

  const agent = await Agent.create({
    apiKey: env("CURSOR_API_KEY"),
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
        "Rules: make the smallest change that fixes the root cause. Run `npm test` and make sure tests/cart.test.ts passes.",
        `Reference "Fixes #${number}" in the PR description.`,
      ].join("\n"),
    );
    const result = await run.wait();
    const pr = result.git?.branches.find((b) => b.prUrl)?.prUrl;
    await gh.comment(
      number,
      result.status === "finished" && pr
        ? `Cursor opened a fix: ${pr}`
        : `Cursor run ended with status \`${result.status}\`. ${pr ?? "No PR was created."}`,
    );
    await gh.setLabels(number, [gh.FEEDBACK_LABEL, gh.LABEL_APPROVED]);
    return { status: result.status, prUrl: pr };
  } finally {
    agent.close();
  }
}
