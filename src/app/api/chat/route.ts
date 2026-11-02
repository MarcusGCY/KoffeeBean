import { NextResponse } from "next/server";
import { z } from "zod";
import { askSupportAgent, chatFailureStatus, supportConfigured, supportTranscript, SupportTimeoutError } from "@/lib/agent-chat";
import { confirmedCard } from "@/lib/pending-action";
import { CHAT_RATE_LIMIT_MESSAGE, chatLimiter } from "@/lib/chat-rate-limit";
import { getShopper } from "@/lib/shopper";
import { StoreUnavailableError } from "@/lib/store-error";
import { rememberUserLines } from "@/lib/upstash";

export const maxDuration = 300;

const MAX_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024;
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
  sessionId: z.string().min(1).max(200).optional(),
  continuationToken: z.string().min(1).max(2000).optional(),
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

  const message = supportTranscript(parsed.data.messages);
  if (!message) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 400 });
  }

  if (!supportConfigured()) {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  try {
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

    const userLines = parsed.data.messages.flatMap((turn) => (turn.role === "user" ? [turn.content] : []));
    await rememberUserLines(shopper.id, userLines);

    const reply = await askSupportAgent({
      userId: shopper.id,
      message,
    });
    const rawSecret = process.env.APPROVAL_SECRET?.trim() ?? "";
    const pendingAction = reply.pendingAction
      ? confirmedCard(shopper.id, reply.pendingAction.actionId, rawSecret)
      : undefined;
    return NextResponse.json({ ...reply, pendingAction });
  } catch (err) {
    if (err instanceof SupportTimeoutError) {
      return NextResponse.json({ error: "Support chat timed out. Please try again." }, { status: 504 });
    }
    if (err instanceof StoreUnavailableError) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    const failure = chatFailureStatus(err);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}
