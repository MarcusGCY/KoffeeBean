import { NextResponse } from "next/server";
import { z } from "zod";
import { biSessionId, biSource, emitBi, rememberShownRecommendation, startTurn, trackTurn } from "@/lib/bi-track";
import { CHAT_TIMEOUT, CHAT_UNAVAILABLE } from "@/lib/chat-response";
import { CHAT_TOOLS } from "@/lib/chat-tools";
import { CHAT_RATE_LIMIT_MESSAGE, chatLimiter } from "@/lib/chat-rate-limit";
import { getShopper } from "@/lib/shopper";
import { StoreUnavailableError } from "@/lib/store-error";
import { rememberUserLines } from "@/lib/upstash";
import {
  CHAT_TIMEOUT_MS,
  HEARTBEAT_MS,
  cappedTurns,
  chatFailureStatus,
  chatOkLine,
  runXaiChat,
  scrubSecrets,
  supportConfigured,
  vitestMs,
} from "@/lib/xai-chat";

export const maxDuration = 60;

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

  const turns = cappedTurns(parsed.data.messages);
  if (turns.length === 0) {
    return NextResponse.json({ error: "That message could not be sent." }, { status: 400 });
  }

  if (!supportConfigured()) {
    console.error("[chat] unconfigured");
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  const bi = {
    sub: shopper.id,
    source: await biSource(),
    sessionId: biSessionId(parsed.data.sessionId),
  };
  const userMessageChars = turns[turns.length - 1]?.content.length ?? 0;

  try {
    const limit = await chatLimiter.check(shopper.id);
    if (!limit.ok) {
      emitBi(() => trackTurn(bi, { outcome: "rate_limited", userMessageChars, toolIds: [], latencyMs: 0 }));
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
  } catch (err) {
    if (err instanceof StoreUnavailableError) {
      console.error("[chat] store unavailable");
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    const failure = chatFailureStatus(err);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }

  const started = Date.now();
  const turn = startTurn(
    bi,
    userMessageChars,
    CHAT_TOOLS.map((tool) => tool.function.name),
  );
  let outcome: "replied" | "timeout" | "error" = "error";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const sendRaw = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown) => {
        sendRaw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send("status", { text: "Looking that up…" });
      const heartbeat = setInterval(() => sendRaw(`: heartbeat\n\n`), vitestMs("CHAT_HEARTBEAT_MS", HEARTBEAT_MS));
      const controllerAbort = new AbortController();
      const timer = setTimeout(() => controllerAbort.abort(), vitestMs("CHAT_TIMEOUT_MS", CHAT_TIMEOUT_MS));
      try {
        const result = await runXaiChat({
          userId: shopper.id,
          turns,
          signal: controllerAbort.signal,
          sessionId: bi.sessionId,
          onTool: (name) => turn.tool(name),
          sink: {
            status: (text) => send("status", { text }),
            products: async (products) => {
              const productIds = products.map((product) => product.id);
              const recommendationId = turn.shownProducts(productIds);
              send("products", { products, recommendationId });
              await rememberShownRecommendation(shopper.id, bi.sessionId, recommendationId, productIds);
            },
            text: (delta) => send("text", { delta }),
            confirm: (card) => send("confirm", card),
            order: (order) => send("order", order),
            error: (message, retry) => send("error", { message, ...(retry ? { retry: true } : {}) }),
          },
        });
        if (result.ok) {
          outcome = "replied";
          console.log(scrubSecrets(chatOkLine(Date.now() - started, result.reply.length, result.model, result)));
          send("done", { suggestions: result.suggestions });
        }
      } catch (err) {
        if (controllerAbort.signal.aborted) {
          outcome = "timeout";
          console.error("[chat] timeout");
          send("error", { message: CHAT_TIMEOUT, retry: true });
        } else if (err instanceof StoreUnavailableError) {
          console.error("[chat] store unavailable");
          send("error", { message: CHAT_UNAVAILABLE });
        } else {
          const failure = chatFailureStatus(err);
          send("error", { message: failure.status === 504 ? CHAT_TIMEOUT : CHAT_UNAVAILABLE, retry: true });
        }
      } finally {
        turn.finish(outcome);
        clearInterval(heartbeat);
        clearTimeout(timer);
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
