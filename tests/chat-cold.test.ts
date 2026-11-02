import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

type ColdResult = {
  reply: string;
  message: string;
  sent: { url: string; method: string; body: string }[];
};

function coldTurn(home: string, history: { role: string; content: string }[], reply: string): Promise<ColdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/cold-chat-runner.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TMPDIR: home,
        CHAT_HISTORY: JSON.stringify(history),
        TURN_REPLY: reply,
        VITEST: "1",
        CHAT_TEST_AGENT_URL: "http://127.0.0.1:9",
        CURSOR_API_KEY: "cursor-test",
        APPROVAL_SECRET: "test-secret",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.slice(-500) || `exit_${code}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1) ?? "";
      resolve(JSON.parse(line) as ColdResult);
    });
  });
}

describe("chat across cold processes", () => {
  it("keeps the prior text on a second process with a new temp dir", async () => {
    const homeA = await mkdtemp(path.join(tmpdir(), "chat-a-"));
    const homeB = await mkdtemp(path.join(tmpdir(), "chat-b-"));
    try {
      const first = await coldTurn(homeA, [{ role: "user", content: "What beans do you sell?" }], "We sell three coffees.");
      expect(first.reply).toBe("We sell three coffees.");
      expect(first.message).toBe("What beans do you sell?");
      expect(first.sent.some((call) => call.method === "POST" && /\/v1\/session\/[^/]+$/.test(call.url))).toBe(false);

      const second = await coldTurn(
        homeB,
        [
          { role: "user", content: "What beans do you sell?" },
          { role: "assistant", content: first.reply },
          { role: "user", content: "Which one is decaf?" },
        ],
        "The decaf is the house blend.",
      );
      expect(second.reply).toBe("The decaf is the house blend.");
      expect(second.message).toContain("What beans do you sell?");
      expect(second.message).toContain("We sell three coffees.");
      expect(second.message).toContain("Which one is decaf?");
      expect(second.message).not.toContain("test-secret");
      expect(second.sent.some((call) => call.method === "POST" && /\/v1\/session\/[^/]+$/.test(call.url))).toBe(false);
      expect(
        second.sent.some(
          (call) => call.method === "POST" && call.url.endsWith("/v1/session") && call.body.includes("We sell three coffees."),
        ),
      ).toBe(true);
    } finally {
      await rm(homeA, { recursive: true, force: true });
      await rm(homeB, { recursive: true, force: true });
    }
  }, 20_000);
});
