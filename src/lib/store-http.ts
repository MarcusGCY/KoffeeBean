import { NextResponse } from "next/server";
import { getShopper } from "./shopper";

export async function requireShopper(): Promise<{ userId: string } | NextResponse> {
  const shopper = await getShopper();
  if (!shopper) return NextResponse.json({ error: "Sign in to shop." }, { status: 401 });
  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
  return { userId: shopper.id };
}

/** Writes must be JSON from the configured app origin. userId is never read from the body. */
export function requireWrite(req: Request): NextResponse | null {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Expected JSON." }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  const base = process.env.APP_BASE_URL?.trim().replace(/\/$/, "");
  if (!origin || !base) return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  try {
    if (new URL(origin).origin !== new URL(base).origin) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }
  return null;
}

export async function readJson(req: Request): Promise<unknown | NextResponse> {
  try {
    return await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON." }, { status: 400 });
  }
}

export function dbFailure(err: unknown): NextResponse {
  if (err instanceof Error && err.name === "StoreUnavailableError") {
    return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
  }
  const code =
    typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "error";
  console.error("[store] query failed", code);
  return NextResponse.json({ error: "store_unavailable" }, { status: 503 });
}
