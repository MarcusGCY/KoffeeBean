import { NextResponse } from "next/server";
import { StaleEpochError } from "@/lib/demo/state";
import { StoreUnavailableError } from "@/lib/store-error";
import { YuuQueryError, YuuUnavailableError, YuuUnconfiguredError, isMissingYuuTable } from "./db";

const NO_STORE = { "cache-control": "private, no-store" };

export function yuuJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function yuuFailure(error: unknown, log: string): NextResponse {
  if (error instanceof YuuQueryError) return yuuJson({ error: error.message }, 400);
  if (error instanceof YuuUnconfiguredError) return yuuJson({ error: "unconfigured" }, 503);
  if (error instanceof StaleEpochError) return yuuJson({ error: "reset_during_request" }, 409);
  if (error instanceof StoreUnavailableError) return yuuJson({ error: "store_unavailable" }, 503);
  if (error instanceof YuuUnavailableError || isMissingYuuTable(error)) return yuuJson({ error: "unavailable" }, 503);
  console.error(log, error instanceof Error ? error.name : "unknown");
  return yuuJson({ error: "unavailable" }, 503);
}
