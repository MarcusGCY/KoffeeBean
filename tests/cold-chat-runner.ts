import { askSupportAgent, supportTranscript } from "../src/lib/agent-chat";

process.env.VITEST = "1";
process.env.CHAT_TEST_AGENT_URL = "http://127.0.0.1:9";
process.env.CURSOR_API_KEY = "cursor-test";
process.env.APPROVAL_SECRET = "test-secret";

const sent: { url: string; method: string; body: string }[] = [];

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body == null ? "" : String(init.body);
  sent.push({ url, method, body });
  if ((init?.method ?? "GET") === "POST" && url.endsWith("/v1/session")) {
    return Response.json({ ok: true, sessionId: "ses_fresh", continuationToken: "tok" });
  }
  if (url.includes("/events")) {
    return Response.json({
      events: [
        {
          type: "message.completed",
          data: { text: process.env.TURN_REPLY ?? "ok", finishReason: "stop" },
        },
        { type: "turn.completed", data: {} },
      ],
    });
  }
  return new Response("missing", { status: 404 });
};

async function main(): Promise<void> {
  const history = JSON.parse(process.env.CHAT_HISTORY ?? "[]") as { role: string; content: string }[];
  const message = supportTranscript(history);
  const reply = await askSupportAgent({ userId: "auth0|shopper", message });
  process.stdout.write(JSON.stringify({ reply: reply.reply, message, sent }));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "cold_turn_failed");
  process.exit(1);
});
