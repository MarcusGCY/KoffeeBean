import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const testPath = process.env.TEST_PATH ?? "";
const testSha = (process.env.TEST_SHA ?? "").toLowerCase();

function emit(obj) {
  process.stdout.write(`REPRO_RESULT ${JSON.stringify(obj)}\n`);
}

const pathOk = /^tests\/repro\/[A-Za-z0-9][A-Za-z0-9_-]*\.test\.ts$/.test(testPath);
if (!pathOk || !/^[0-9a-f]{40}$/.test(testSha)) {
  emit({ error: "bad-input" });
  process.exit(1);
}

const fetched = spawnSync("git", ["fetch", "--depth=1", "origin", testSha], { stdio: "inherit" });
if (fetched.status !== 0) process.exit(fetched.status ?? 1);

const shown = spawnSync("git", ["show", `${testSha}:${testPath}`], { encoding: "utf8" });
if (shown.status !== 0 || !shown.stdout.trim()) {
  emit({ error: "missing-file" });
  process.exit(1);
}

mkdirSync(dirname(testPath), { recursive: true });
writeFileSync(testPath, shown.stdout);
spawnSync("git", ["config", "--unset-all", "http.https://github.com/.extraheader"], { stdio: "ignore" });

const out = `${process.env.RUNNER_TEMP}/repro-report.json`;
const env = { ...process.env };
delete env.GITHUB_TOKEN;
delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
spawnSync(
  "npx",
  ["vitest", "run", testPath, "--reporter=json", `--outputFile=${out}`],
  { env, stdio: "inherit" },
);

let report;
try {
  report = JSON.parse(readFileSync(out, "utf8"));
} catch {
  emit({ error: "no-report" });
  process.exit(1);
}

const results = Array.isArray(report.testResults) ? report.testResults : [];
const compact = {
  testResults: results.map((suite) => ({
    name: typeof suite.name === "string" && suite.name.endsWith(testPath) ? testPath : suite.name,
    status: suite.status,
    message: typeof suite.message === "string" ? suite.message.slice(0, 500).replace(/\n/g, " ") : "",
    assertionResults: (suite.assertionResults ?? []).map((item) => ({
      status: item.status,
      failureMessages: (item.failureMessages ?? []).map((line) => String(line).replace(/\n/g, " ").slice(-1500)),
    })),
  })),
};
emit(compact);
const failed = compact.testResults.some((suite) =>
  suite.assertionResults.some((item) => item.status === "failed"),
);
process.exit(failed ? 1 : 0);
