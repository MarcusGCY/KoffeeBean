import { Agent, type SDKAgentInfo } from "@cursor/sdk";
import { env } from "./env";
import { BEANBOX_ISSUE_METADATA } from "./fix-marker";
import { issueNumbersFromText } from "./issue-refs";

export type PullWake = { issue: number; prUrl?: string; agentId?: string };

/**
 * Issues a pull_request webhook should resume. Text references wake the
 * stored run. An agent listed for this PR url also supplies the PR link,
 * because that PR belongs to the cloud agent.
 */
export async function wakesForPullRequest(pr: {
  title: string;
  body: string;
  html_url: string;
}): Promise<PullWake[]> {
  const linked = new Map<number, PullWake>();
  for (const issue of issueNumbersFromText(`${pr.title}\n${pr.body}`)) {
    linked.set(issue, { issue });
  }
  try {
    const listed = await Agent.list({
      runtime: "cloud",
      prUrl: pr.html_url,
      apiKey: env("CURSOR_API_KEY"),
    });
    for (const agent of listed.items) {
      const issue = issueFromAgent(agent);
      if (!issue) continue;
      linked.set(issue, { issue, prUrl: pr.html_url, agentId: agent.agentId });
    }
  } catch (err) {
    console.error("[github-webhook] cloud agent lookup failed", err);
  }
  return [...linked.values()];
}

function issueFromAgent(agent: SDKAgentInfo): number | undefined {
  if (agent.runtime !== "cloud") return undefined;
  const raw = agent.metadata?.[BEANBOX_ISSUE_METADATA];
  const issue = Number(raw);
  if (!Number.isInteger(issue) || issue <= 0) return undefined;
  return issue;
}
