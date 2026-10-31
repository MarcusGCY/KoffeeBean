import { NextResponse } from "next/server";
import { z } from "zod";
import { completionMessages } from "@/lib/chat-prompt";
import { CHAT_RATE_LIMIT_MESSAGE, chatLimiter } from "@/lib/chat-rate-limit";
import { getShopper } from "@/lib/shopper";

// Upstream call is aborted at 15s; leave room for that on Fluid compute.
export const maxDuration = 30;

const MAX_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 15_000;
const UNAVAILABLE = "Support chat is unavailable";

const Body = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(MAX_CHARS),
      }),
    )
    .min(1)
    .max(6),
});

export async function POST(req: Request) {
  const shopper = await getShopper();
  if (!shopper) {
    return NextResponse.json({ error: "Sign in to use support chat." }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }

  const parsed = Body.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 400 });
  }

  // Client assistant turns are display history only. The model sees user turns, newest last.
  const turns = parsed.data.messages.flatMap((turn) =>
    turn.role === "user" ? [{ role: "user" as const, content: turn.content }] : [],
  );
  if (!turns.some((turn) => turn.content.trim())) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 400 });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const limit = await chatLimiter.check(shopper.id);
  if (!limit.ok) {
    return NextResponse.json(
      { error: CHAT_RATE_LIMIT_MESSAGE },
      {
        status: 429,
        headers: limit.retryAfterSec ? { "retry-after": String(limit.retryAfterSec) } : undefined,
      },
    );
  }

  const model = process.env.CHAT_MODEL?.trim() || "gpt-4.1-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        temperature: 0.2,
        messages: completionMessages(turns),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.error("[chat] upstream status", upstream.status);
      return NextResponse.json({ error: UNAVAILABLE }, { status: 502 });
    }

    const data = (await upstream.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      console.error("[chat] upstream missing reply");
      return NextResponse.json({ error: UNAVAILABLE }, { status: 502 });
    }

    return NextResponse.json({ reply: reply.trim() });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error("[chat] request failed", name);
    return NextResponse.json({ error: UNAVAILABLE }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
