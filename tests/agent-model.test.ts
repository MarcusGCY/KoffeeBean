import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: { models: { list } },
}));

import { resetAgentModelCatalog, resolveCursorModel } from "@/lib/agent-model";
import type { ModelSelection } from "@cursor/sdk";

const API_KEY = "test-cursor-key-do-not-log";
const triageFallback: ModelSelection = {
  id: "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};
const fixFallback: ModelSelection = {
  id: "claude-sonnet-5-5",
  params: [
    { id: "reasoning_effort", value: "high" },
    { id: "context", value: "300k" },
  ],
};

beforeEach(() => {
  list.mockReset();
  resetAgentModelCatalog();
  delete process.env.TRIAGE_MODEL;
  delete process.env.FIX_MODEL;
});

afterEach(() => {
  resetAgentModelCatalog();
  delete process.env.TRIAGE_MODEL;
  delete process.env.FIX_MODEL;
});

describe("resolveCursorModel", () => {
  it("uses the cheap triage default, including fast=false, without listing models", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const model = await resolveCursorModel({
      kind: "triage",
      envName: "TRIAGE_MODEL",
      fallback: triageFallback,
      apiKey: API_KEY,
    });
    expect(model).toEqual(triageFallback);
    expect(list).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("[triage] model=composer-2.5");
    expect(log.mock.calls.flat().join("\n")).not.toContain(API_KEY);
    log.mockRestore();
  });

  it("keeps default params when the override names the default model", async () => {
    process.env.FIX_MODEL = "claude-sonnet-5-5";
    const model = await resolveCursorModel({
      kind: "fix",
      envName: "FIX_MODEL",
      fallback: fixFallback,
      apiKey: API_KEY,
    });
    expect(model).toEqual(fixFallback);
    expect(list).not.toHaveBeenCalled();
  });

  it("uses a known override with that model's defaults and caches the catalog", async () => {
    process.env.TRIAGE_MODEL = "grok-4.5";
    list.mockResolvedValue([{ id: "grok-4.5" }, { id: "composer-2.5" }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await resolveCursorModel({
      kind: "triage",
      envName: "TRIAGE_MODEL",
      fallback: triageFallback,
      apiKey: API_KEY,
    });
    const second = await resolveCursorModel({
      kind: "triage",
      envName: "TRIAGE_MODEL",
      fallback: triageFallback,
      apiKey: API_KEY,
    });
    expect(first).toEqual({ id: "grok-4.5" });
    expect(second).toEqual({ id: "grok-4.5" });
    expect(first).not.toHaveProperty("params");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ apiKey: API_KEY });
    expect(log).toHaveBeenCalledWith("[triage] model=grok-4.5");
    log.mockRestore();
  });

  it("falls back when the override id is not in the catalog", async () => {
    process.env.FIX_MODEL = "not-a-model";
    list.mockResolvedValue([{ id: "claude-sonnet-5-5" }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const model = await resolveCursorModel({
      kind: "fix",
      envName: "FIX_MODEL",
      fallback: fixFallback,
      apiKey: API_KEY,
    });
    expect(model).toEqual(fixFallback);
    expect(error).toHaveBeenCalledWith("[fix] unknown FIX_MODEL=not-a-model, using claude-sonnet-5-5");
    expect(log).toHaveBeenCalledWith("[fix] model=claude-sonnet-5-5");
    expect(error.mock.calls.flat().join("\n")).not.toContain(API_KEY);
    error.mockRestore();
    log.mockRestore();
  });

  it("uses the override as given when models.list fails and does not log the key", async () => {
    process.env.TRIAGE_MODEL = "grok-4.5";
    list.mockRejectedValue(new Error(`catalog down ${API_KEY}`));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = await resolveCursorModel({
      kind: "triage",
      envName: "TRIAGE_MODEL",
      fallback: triageFallback,
      apiKey: API_KEY,
    });
    expect(model).toEqual({ id: "grok-4.5" });
    expect(log).toHaveBeenCalledWith("[triage] model=grok-4.5");
    const logged = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
    expect(logged).not.toContain(API_KEY);
    log.mockRestore();
    error.mockRestore();
  });
});
