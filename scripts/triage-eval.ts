import path from "node:path";
import { runTriageEval } from "../src/lib/triage-eval";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live") || process.env.EVAL_LIVE === "1";
  const root = process.cwd();
  const report = await runTriageEval({
    casesDir: path.join(root, "evals/triage"),
    outputDir: path.join(root, "evals/results"),
    testsDir: path.join(root, "tests"),
    cwd: root,
    live,
    basePath: value(args, "--base"),
    headPath: value(args, "--head"),
    testResultPath: value(args, "--test-result"),
  });
  process.exit(report.decision === "GO" ? 0 : 1);
}

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.name : "eval_failed");
  process.exit(1);
});
