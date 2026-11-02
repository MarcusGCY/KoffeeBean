import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const TIMEOUT_MS = 90_000;
const OUTPUT_CAP = 100_000;

/**
 * Run `source` as a vitest file against this process's checkout.
 * The file is temporary and removed when the run finishes.
 */
export async function runTestOnMain(source: string): Promise<{ code: number; output: string }> {
  const dir = path.resolve(process.cwd(), "tests", "repro");
  const file = path.join(dir, `pending-${randomUUID()}.test.ts`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, source, { flag: "wx" });
  try {
    return await execVitest(file);
  } finally {
    await rm(file, { force: true });
  }
}

function execVitest(file: string): Promise<{ code: number; output: string }> {
  const entry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const config = path.join(process.cwd(), "vitest.config.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, "run", file, "--config", config], {
      cwd: process.cwd(),
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (buf: Buffer) => {
      if (size >= OUTPUT_CAP) return;
      const slice = size + buf.length > OUTPUT_CAP ? buf.subarray(0, OUTPUT_CAP - size) : buf;
      chunks.push(slice);
      size += slice.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error("Reproduction test timed out"));
        return;
      }
      const output = Buffer.concat(chunks).toString("utf8");
      if (/No test files found/i.test(output)) {
        reject(new Error("Reproduction test was not collected by vitest"));
        return;
      }
      resolve({ code: code ?? 1, output });
    });
  });
}
