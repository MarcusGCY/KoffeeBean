import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { classifyFeedback, XaiRequestError, XaiUnconfiguredError } from "@/lib/triage-classify";

export const maxDuration = 30;

const MAX_TEXT = 8_000;
const MAX_SHOT = 2_000_000;
const MAX_HTTPS = 2_000;

const Body = z.strictObject({
  text: z.string().trim().min(1).max(MAX_TEXT),
  screenshot: z.string().max(MAX_SHOT).optional(),
  candidates: z
    .array(
      z.strictObject({
        number: z.number().int().positive(),
        title: z.string().max(300),
        body: z.string().max(4_000).optional(),
      }),
    )
    .max(30)
    .optional(),
});

const IMAGE_DATA = /^data:image\/(?:png|jpe?g);base64,[a-z0-9+/=\s]+$/i;

export async function POST(req: Request) {
  const secret = process.env.TRIAGE_API_SECRET?.trim() ?? "";
  if (!secret) return NextResponse.json({ error: "unconfigured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.XAI_API_KEY?.trim()) {
    return NextResponse.json({ error: "XAI_API_KEY is not set" }, { status: 503 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await req.text()) as unknown;
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
  const parsed = Body.safeParse(payload);
  if (!parsed.success) return NextResponse.json({ error: "That report could not be classified." }, { status: 400 });
  if (parsed.data.screenshot && !acceptedShot(parsed.data.screenshot)) {
    return NextResponse.json({ error: "Screenshot must be a png or jpeg data URL, or an https URL." }, { status: 400 });
  }

  try {
    const result = await classifyFeedback({
      text: parsed.data.text,
      screenshot: parsed.data.screenshot,
      candidates: parsed.data.candidates ?? [],
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof XaiUnconfiguredError) {
      return NextResponse.json({ error: "XAI_API_KEY is not set" }, { status: 503 });
    }
    if (err instanceof XaiRequestError) {
      return NextResponse.json({ error: "unavailable" }, { status: 502 });
    }
    console.error("[triage-classify] request failed", err instanceof Error ? err.name : "Error");
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}

function bearerMatches(header: string | null, secret: string): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const got = createHash("sha256").update(match[1]).digest();
  const want = createHash("sha256").update(secret).digest();
  return timingSafeEqual(got, want);
}

function acceptedShot(value: string): boolean {
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && value.length <= MAX_HTTPS && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  return IMAGE_DATA.test(value);
}
