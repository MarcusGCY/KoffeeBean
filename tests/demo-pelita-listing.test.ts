import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "@/data/demo-scenario.json";
import { POST as approvalRoute } from "@/app/api/demo/pelita/approval/route";
import { POST as listingRoute } from "@/app/api/demo/pelita/listing/route";
import { POST as resetRoute } from "@/app/api/demo/pelita/reset/route";
import { PelitaListingDraft } from "@/components/pelita-ops/PelitaListingDraft";
import { PelitaLaunchApproval } from "@/components/pelita-ops/PelitaLaunchApproval";
import { PelitaOpsConsole } from "@/components/pelita-ops/PelitaOpsConsole";
import { PelitaStorefront } from "@/components/pelita/PelitaStorefront";
import { approveLaunch, approveSourcing, sendBackLaunch } from "@/lib/demo/approval";
import { approvalView, launchPhase } from "@/lib/demo/approval-view";
import {
  DESCRIPTION_MAX,
  EDIT_ACTION_PREFIX,
  SEND_ACTION,
  claimsAuditRow,
  draftAuditRow,
  findListingDraft,
  findListingEdit,
  listingDraftView,
  publishAuditRow,
} from "@/lib/demo/listing-view";
import { defaultListingDeps, editListing, mockClaimsCheck, runListingDraft, sendForApproval, setListingDeps, type ListingDeps } from "@/lib/demo/listing";
import { opsConsoleView } from "@/lib/demo/ops-console";
import { PRESENTER_COOKIE, signPresenterToken } from "@/lib/demo/presenter";
import { publishedView } from "@/lib/demo/published-view";
import { rejectProposal } from "@/lib/demo/proposal";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";
import { PAST_STOCK_CHECK_STAGE, PUBLISHED_STAGE, STATE_KEYS, STATE_KEY_NAMES, getDemoState, resetDemo } from "@/lib/demo/state";
import { continueFromStockCheck, defaultStockCheckDeps, runStockCheck } from "@/lib/demo/stock-check";
import { searchCatalogue, storefrontView } from "@/lib/demo/storefront";

const cookieJar: { value: string | undefined } = { value: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.value && name === PRESENTER_COOKIE ? { name, value: cookieJar.value } : undefined),
  }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));

type Command = (string | number)[];

const SECRET = "test-approval-secret";
const ENV_KEYS = ["KB_DEMO_TRACK", "VERCEL_ENV", "APPROVAL_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;
const ROOT = path.resolve(__dirname, "..");
const LISTING_URL = "https://x.test/api/demo/pelita/listing";
const APPROVAL_URL = "https://x.test/api/demo/pelita/approval";
const FOREIGN = {
  "kb:chat:h:user-1": "7",
  "kb:demo:other": "keep",
  "kb:demo:pelita:unlisted": "inside the prefix but not on the fixed list",
};
const NEW_FILES = [
  "src/lib/demo/listing.ts",
  "src/lib/demo/listing-view.ts",
  "src/lib/demo/listing-client.ts",
  "src/lib/demo/published-view.ts",
  "src/components/pelita-ops/PelitaListingDraft.tsx",
  "src/app/api/demo/pelita/listing/route.ts",
];

let store: Map<string, string | string[]>;
let sent: Command[];

function fakeRedis(commands: Command[]): unknown[] {
  return commands.map((command) => {
    sent.push(command);
    const [name, k, ...rest] = command as [string, string, ...(string | number)[]];
    switch (name) {
      case "GET":
        return { result: (store.get(k) as string | undefined) ?? null };
      case "SET":
        store.set(k, String(rest[0]));
        return { result: "OK" };
      case "DEL":
        return { result: store.delete(k) ? 1 : 0 };
      case "RPUSH": {
        const list = (store.get(k) as string[] | undefined) ?? [];
        list.push(String(rest[0]));
        store.set(k, list);
        return { result: list.length };
      }
      case "LRANGE":
        return { result: (store.get(k) as string[] | undefined) ?? [] };
      default:
        return { error: `unsupported ${name}` };
    }
  });
}

function useFakeRedis() {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "redis-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(fakeRedis(JSON.parse(String(init?.body)) as Command[]))),
  );
}

function openGate() {
  process.env.KB_DEMO_TRACK = "pelita";
  process.env.APPROVAL_SECRET = SECRET;
  cookieJar.value = signPresenterToken(SECRET);
}

function post(url: string, body: unknown, opts: { cookie?: boolean; origin?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json", origin: opts.origin ?? "https://x.test" });
  if (opts.cookie !== false) headers.set("cookie", `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}`);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function editedScenario(edit: (draft: typeof raw) => void) {
  const draft = structuredClone(raw);
  edit(draft);
  return parseScenario(draft);
}

const scenario = loadScenario();
const [first, second] = [...scenario.approvers].sort((a, b) => a.slot - b.slot);
const T1 = new Date("2026-11-25T01:03:35.000Z");
const T_DRAFT = new Date("2026-11-25T01:06:20.000Z");
const T_EDIT = new Date("2026-11-25T01:07:10.000Z");
const T_SEND = new Date("2026-11-25T01:07:50.000Z");
const T2 = new Date("2026-11-25T01:09:05.000Z");
const phaseOf = async () => launchPhase(scenario, await getDemoState());
const sourcingApproved = () => approveSourcing(scenario, { approverId: first.id, confirmed: true }, T1);
const writes = () => sent.filter(([name]) => name !== "GET" && name !== "LRANGE");

/** Instant waits that remember every delay they were asked for. */
function instantDeps(overrides: Partial<ListingDeps> = {}): ListingDeps & { waits: number[] } {
  const waits: number[] = [];
  return {
    ...defaultListingDeps,
    wait: async (ms) => void waits.push(ms),
    now: () => T_DRAFT,
    ...overrides,
    waits,
  };
}

async function toScreen04(): Promise<void> {
  await sourcingApproved();
  await runStockCheck(scenario, { ...defaultStockCheckDeps, wait: async () => undefined });
  await continueFromStockCheck(scenario);
}

async function toScreen05(): Promise<void> {
  await toScreen04();
  await runListingDraft(scenario, instantDeps());
  await sendForApproval(scenario, { approverId: first.id }, T_SEND);
}

beforeEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  store = new Map(Object.entries(FOREIGN));
  sent = [];
});

afterEach(() => {
  for (const name of ENV_KEYS) delete process.env[name];
  cookieJar.value = undefined;
  setListingDeps(null);
  vi.unstubAllGlobals();
});

describe("the listing draft (screen 04)", () => {
  beforeEach(useFakeRedis);

  it("cannot start before approval 1 or the stock check, or after a rejection", async () => {
    const deps = instantDeps();
    expect(await runListingDraft(scenario, deps)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await editListing(scenario, { approverId: first.id, description: "x" }, T_EDIT)).toEqual({ ok: false, reason: "sourcing_required" });
    expect(await sendForApproval(scenario, { approverId: first.id }, T_SEND)).toEqual({ ok: false, reason: "sourcing_required" });
    await sourcingApproved();
    expect(await runListingDraft(scenario, deps)).toEqual({ ok: false, reason: "stock_check_required" });
    expect(deps.waits).toEqual([]);
    expect(await getDemoState()).toMatchObject({ audit: [expect.objectContaining({ ref: scenario.sourcing.approvalId })] });

    await resetDemo();
    await rejectProposal(scenario, T1);
    expect(await runListingDraft(scenario, deps)).toEqual({ ok: false, reason: "proposal_rejected" });
  });

  it("is a real draft only once both agent rows exist, written together after the claims check's delay", async () => {
    await toScreen04();
    expect(await phaseOf()).toBe("listing_draft");
    expect(findListingDraft(scenario, await getDemoState())).toBeNull();
    expect(listingDraftView(scenario, await getDemoState())).toMatchObject({ complete: false, doneLabel: null, canEdit: false, canSend: false });

    const deps = instantDeps();
    sent = [];
    const result = await runListingDraft(scenario, deps);
    expect(result).toMatchObject({ ok: true, changed: true, phase: "listing_draft", draft: { complete: true, doneLabel: "Drafted · 09:06" } });
    expect(deps.waits).toHaveLength(1);
    expect(deps.waits[0]).toBeGreaterThanOrEqual(600);
    expect(deps.waits[0]).toBeLessThanOrEqual(900);
    expect(writes().map(([name]) => name)).toEqual(["RPUSH", "RPUSH"]);

    const rows = (await getDemoState()).audit.slice(-2);
    const claims = claimsAuditRow(scenario);
    const draft = draftAuditRow(scenario);
    expect(rows).toEqual([
      { at: T_DRAFT.toISOString(), actorKind: "agent", actor: claims.actor, action: claims.action, source: claims.source, ref: scenario.claimsCheck.id },
      { at: T_DRAFT.toISOString(), actorKind: "agent", actor: draft.actor, action: draft.action, source: draft.source, ref: scenario.listing.id },
    ]);
    expect(findListingDraft(scenario, await getDemoState())).toEqual({ at: T_DRAFT.toISOString(), atLabel: "09:06" });
  });

  it("runs once: a second run returns the draft without waiting or writing again", async () => {
    await toScreen04();
    await runListingDraft(scenario, instantDeps());
    const before = (await getDemoState()).audit.length;
    sent = [];
    const again = instantDeps();
    expect(await runListingDraft(scenario, again)).toMatchObject({ ok: true, changed: false, draft: { complete: true } });
    expect(again.waits).toEqual([]);
    expect(writes()).toEqual([]);
    expect((await getDemoState()).audit).toHaveLength(before);
  });

  it("writes nothing when the claims check fails or its rules would keep the removed claim", async () => {
    await toScreen04();
    const before = structuredClone(await getDemoState());
    const failing = instantDeps({
      claims: async (s, d) => ({ ...(await mockClaimsCheck(s, d)), status: "failed" as never }),
    });
    expect(await runListingDraft(scenario, failing)).toEqual({ ok: false, reason: "claims_failed" });
    expect(await getDemoState()).toEqual(before);

    const dirty = editedScenario((draft) => {
      draft.listing.description = `Gentle magnesium. ${draft.claimsCheck.removed[0].claim}.`;
    });
    expect(await runListingDraft(dirty, instantDeps())).toEqual({ ok: false, reason: "claims_failed" });
    expect(await getDemoState()).toEqual(before);
  });

  it("shows the fixture draft: preview, fields, the claims removal as old → new, and no real medicinal claim", () => {
    const view = listingDraftView(scenario, { audit: [] });
    expect(view).toMatchObject({ isDemo: true, demoTag: scenario.demoTag, kicker: "DRAFTED BY SHELF AGENT · REVIEW BEFORE SENDING" });
    expect(view.preview).toMatchObject({
      badge: "Not live yet",
      tag: "New",
      ribbon: scenario.promo.ribbon,
      title: scenario.listing.title,
      price: "S$32.90",
      unitPrice: "S$0.37 per capsule",
    });
    expect(view.preview.category).toBe("Vitamins & supplements › Magnesium & minerals");
    expect(view.title.value).toBe(scenario.listing.title);
    expect(view.description.value).toBe(scenario.listing.description);
    expect(Object.fromEntries(view.fields.map((f) => [f.label, f.value]))).toEqual({
      Category: scenario.listing.category,
      Price: `S$32.90 · ${scenario.listing.unitPrice}`,
      "Launch promo": scenario.promo.ribbon,
      Runs: scenario.promo.runsLabel,
      "Online stock": `${scenario.listing.onlineStock} units`,
      "Margin at promo": `${scenario.promo.marginPct}% · floor is ${scenario.promo.marginFloorPct}%`,
    });
    expect(view.claims).toMatchObject({
      id: scenario.claimsCheck.id,
      label: "Claims check passed",
      detail: `${scenario.claimsCheck.ruleset} · 1 claim removed`,
      oldText: "cures insomnia",
      newText: "supports relaxation and restful sleep",
    });
    expect(view.claims.removed).toEqual([{ claim: "cures insomnia", reason: "medicinal claim" }]);
    expect(view.description.value).not.toMatch(/insomnia/i);
    expect(view.sendLabel).toBe("Send for approval →");
  });

  it("follows fixture edits", () => {
    const edited = editedScenario((draft) => {
      draft.promo.ribbon = "2 for S$54.90";
      draft.promo.marginPct = 31;
      draft.listing.onlineStock = 250;
      draft.claimsCheck.removed.push({ claim: "cures anxiety", reason: "medicinal claim" });
      draft.claimsCheck.removedCount = 2;
    });
    const view = listingDraftView(edited, { audit: [] });
    expect(view.preview.ribbon).toBe("2 for S$54.90");
    expect(view.fields.find((f) => f.label === "Margin at promo")?.value).toBe("31% · floor is 15%");
    expect(view.fields.find((f) => f.label === "Online stock")?.value).toBe("250 units");
    expect(view.claims.detail).toContain("2 claims removed");
    expect(view.claims.oldText).toBe("cures insomnia, cures anxiety");
  });
});

describe("Edit on the draft", () => {
  beforeEach(useFakeRedis);

  it("records a human edit as one audit row and shows it as old → new on screen 05", async () => {
    await toScreen04();
    await runListingDraft(scenario, instantDeps());
    const before = (await getDemoState()).audit.length;
    const text = "Gentle magnesium for calm evenings. One capsule a day. Vegan.";
    const result = await editListing(scenario, { approverId: first.id, description: `  ${text}\n` }, T_EDIT);
    expect(result).toMatchObject({ ok: true, changed: true, phase: "listing_draft", draft: { description: { value: text, edited: { by: first.name, atLabel: "09:07" } } } });

    const state = await getDemoState();
    expect(state.audit).toHaveLength(before + 1);
    expect(state.audit[before]).toEqual({
      at: T_EDIT.toISOString(),
      actorKind: "human",
      actor: `${first.name} · ${first.role}`,
      action: `${EDIT_ACTION_PREFIX}: ${text}`,
      source: "Ops console",
      ref: scenario.listing.id,
    });
    expect(findListingEdit(scenario, state)).toMatchObject({ text, by: first.name });
    expect(await phaseOf()).toBe("listing_draft");

    expect(result.ok && result.launch.diff.find((row) => row.label === "Description")).toEqual({
      label: "Description",
      value: text,
      old: scenario.listing.description,
    });
    expect(approvalView(scenario, state).launch.diff.find((row) => row.label === "Description")?.old).toBe(scenario.listing.description);
  });

  it("is a no-op for unchanged text, and the latest edit wins", async () => {
    await toScreen04();
    await runListingDraft(scenario, instantDeps());
    const same = await editListing(scenario, { approverId: first.id, description: scenario.listing.description }, T_EDIT);
    expect(same).toMatchObject({ ok: true, changed: false });
    const rows = (await getDemoState()).audit.length;
    await editListing(scenario, { approverId: first.id, description: "First wording." }, T_EDIT);
    await editListing(scenario, { approverId: second.id, description: "Second wording." }, T_EDIT);
    expect((await getDemoState()).audit).toHaveLength(rows + 2);
    expect(findListingEdit(scenario, await getDemoState())).toMatchObject({ text: "Second wording.", by: second.name });
  });

  it("refuses an unknown person, empty or over-long text, and any wording that brings back a removed claim", async () => {
    await toScreen04();
    expect(await editListing(scenario, { approverId: first.id, description: "Before the draft exists." }, T_EDIT)).toEqual({ ok: false, reason: "draft_required" });
    await runListingDraft(scenario, instantDeps());
    const before = structuredClone(await getDemoState());
    expect(await editListing(scenario, { approverId: "nobody", description: "Text." }, T_EDIT)).toEqual({ ok: false, reason: "unknown_approver" });
    expect(await editListing(scenario, { approverId: first.id, description: "   " }, T_EDIT)).toEqual({ ok: false, reason: "invalid_description" });
    expect(await editListing(scenario, { approverId: first.id, description: "x".repeat(DESCRIPTION_MAX + 1) }, T_EDIT)).toEqual({ ok: false, reason: "invalid_description" });
    for (const claim of scenario.claimsCheck.removed.map((r) => r.claim)) {
      expect(await editListing(scenario, { approverId: first.id, description: `Gentle. ${claim.toUpperCase()} nightly.` }, T_EDIT)).toEqual({ ok: false, reason: "claim_not_allowed" });
    }
    expect(await getDemoState()).toEqual(before);
  });

  it("is closed once the draft is sent for approval", async () => {
    await toScreen05();
    expect(await editListing(scenario, { approverId: first.id, description: "Late change." }, T_EDIT)).toEqual({ ok: false, reason: "already_sent" });
  });
});

describe("Send for approval opens screen 05", () => {
  beforeEach(useFakeRedis);

  it("needs the draft, records one human row and moves the stage in one request, and repeats as a no-op", async () => {
    await toScreen04();
    expect(await sendForApproval(scenario, { approverId: first.id }, T_SEND)).toEqual({ ok: false, reason: "draft_required" });
    expect(await sendForApproval(scenario, { approverId: "nobody" }, T_SEND)).toEqual({ ok: false, reason: "unknown_approver" });
    await runListingDraft(scenario, instantDeps());
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "listing_required" });
    expect(await sendBackLaunch(scenario, { approverId: second.id }, T2)).toEqual({ ok: false, reason: "listing_required" });

    sent = [];
    const result = await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    expect(result).toMatchObject({ ok: true, changed: true, phase: "launch_pending", launch: { chip: `Records as ${scenario.launchApproval.approvalId}` } });
    expect(writes().map(([name, target]) => [name, String(target).replace("kb:demo:pelita:", "")])).toEqual([
      ["RPUSH", "audit"],
      ["SET", "stage"],
    ]);
    const state = await getDemoState();
    expect(state.stage).toBe(5);
    expect(state.audit.at(-1)).toEqual({
      at: T_SEND.toISOString(),
      actorKind: "human",
      actor: `${first.name} · ${first.role}`,
      action: SEND_ACTION,
      source: "Ops console",
      ref: scenario.listing.id,
    });
    expect(await phaseOf()).toBe("launch_pending");

    const rows = state.audit.length;
    expect(await sendForApproval(scenario, { approverId: first.id }, T_SEND)).toMatchObject({ ok: true, changed: false, phase: "launch_pending" });
    expect((await getDemoState()).audit).toHaveLength(rows);
  });

  it("the continue step never moves a draft that is already on screen 05 back to screen 04", async () => {
    await toScreen05();
    expect(await continueFromStockCheck(scenario)).toMatchObject({ ok: true, changed: false, phase: "launch_pending" });
    expect((await getDemoState()).stage).toBe(5);
    expect(PAST_STOCK_CHECK_STAGE).toBe(4);
  });
});

describe("Approval 2 publishes", () => {
  beforeEach(useFakeRedis);

  it("sets the product to listed, moves to screen 06 and writes the approval and the storefront row, in one request", async () => {
    await toScreen05();
    expect((await getDemoState()).listed).toBe(false);
    sent = [];
    const result = await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      phase: "launched",
      published: {
        title: scenario.published.toastTitle,
        line1: `Published 09:09 · approved by ${second.name}`,
        line2: `${scenario.launchApproval.approvalId} · ${scenario.listing.onlineStock} units online`,
        liveIn: "Live in about 7 minutes",
        liveInDetail: `${scenario.timing.totalLabel} from detection to live`,
      },
    });

    const calls = writes();
    expect(calls.map(([name, target]) => [name, String(target).replace("kb:demo:pelita:", "")])).toEqual([
      ["SET", "approvals"],
      ["RPUSH", "audit"],
      ["RPUSH", "audit"],
      ["SET", "listed"],
      ["SET", "stage"],
    ]);
    const state = await getDemoState();
    expect(state).toMatchObject({ listed: true, stage: PUBLISHED_STAGE });
    const publish = publishAuditRow(scenario);
    expect(state.audit.slice(-2)).toEqual([
      expect.objectContaining({ actorKind: "human", ref: scenario.launchApproval.approvalId, action: "Approved listing and promo" }),
      { at: T2.toISOString(), actorKind: "system", actor: publish.actor, action: publish.action, source: publish.source, ref: publish.ref },
    ]);
    expect(publishedView(scenario, state)).toEqual(result.ok ? result.published : null);
  });

  it("does not publish twice, by the same person or by anyone else, and a refused approval lists nothing", async () => {
    await toScreen05();
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: false }, T2)).toEqual({ ok: false, reason: "confirmation_required" });
    expect(await approveLaunch(scenario, { approverId: first.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "same_person" });
    expect((await getDemoState()).listed).toBe(false);

    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    const after = structuredClone(await getDemoState());
    sent = [];
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "already_approved" });
    expect(writes()).toEqual([]);
    expect(await getDemoState()).toEqual(after);
  });

  it("never lists a draft that was sent back, and publishedView stays empty until the product is listed", async () => {
    await toScreen05();
    await sendBackLaunch(scenario, { approverId: second.id }, T2);
    expect(await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2)).toEqual({ ok: false, reason: "sent_back" });
    const state = await getDemoState();
    expect(state.listed).toBe(false);
    expect(publishedView(scenario, state)).toBeNull();
    expect(publishedView(scenario, { approvals: { launch: { approvalId: "x", approverId: second.id, at: T2.toISOString() } }, audit: [], listed: false })).toBeNull();
  });

  it("Reset clears the draft, the edit, the approvals, the listing and the stage, and the flow runs again", async () => {
    await toScreen04();
    await runListingDraft(scenario, instantDeps());
    await editListing(scenario, { approverId: first.id, description: "A calmer wording." }, T_EDIT);
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    expect(await getDemoState()).toMatchObject({ listed: true, stage: PUBLISHED_STAGE });

    expect(await resetDemo()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
    for (const name of ["approvals", "audit"]) expect(store.get(`kb:demo:pelita:${name}`)).toBeUndefined();
    expect(store.get("kb:demo:pelita:listed")).toBe("0");
    expect(store.get("kb:demo:pelita:stage")).toBe("0");
    for (const [name, value] of Object.entries(FOREIGN)) expect(store.get(name)).toBe(value);
    expect(findListingEdit(scenario, await getDemoState())).toBeNull();
    expect(findListingDraft(scenario, await getDemoState())).toBeNull();
    expect(storefrontView(scenario, { listed: (await getDemoState()).listed }).catalogue).toHaveLength(19);

    await toScreen05();
    expect(await phaseOf()).toBe("launch_pending");
  });

  it("adds no state key: the fixed list is unchanged and every write stays inside it", async () => {
    await toScreen05();
    await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    await resetDemo();
    expect(STATE_KEY_NAMES).toEqual(["stage", "approvals", "audit", "listed"]);
    expect(sent.length).toBeGreaterThan(0);
    for (const [name, target] of sent) {
      expect(["GET", "SET", "DEL", "RPUSH", "LRANGE"]).toContain(name);
      expect(String(target).startsWith("kb:demo:pelita:")).toBe(true);
      expect(STATE_KEYS).toContain(target);
    }
  });
});

describe("the storefront shows the published product (screen 06)", () => {
  const live = (options: { listed?: boolean } = { listed: true }) => {
    const approvals = { launch: { approvalId: scenario.launchApproval.approvalId, approverId: second.id, at: T2.toISOString() } };
    const state = { approvals, audit: [publishAuditRow(scenario)].map((row) => ({ ...row, at: T2.toISOString() })), listed: options.listed === true };
    return storefrontView(scenario, { listed: options.listed, published: publishedView(scenario, state) });
  };
  const html = (view = live()) => renderToStaticMarkup(createElement(PelitaStorefront, { view }));

  it("lists the product only once it is listed, and the unlisted storefront is unchanged", () => {
    const before = storefrontView(scenario);
    expect(before.published).toBeNull();
    expect(before.catalogue).toHaveLength(19);
    expect(before.catalogue.map((p) => p.id)).not.toContain(scenario.listing.productId);
    expect(storefrontView(scenario, { listed: false })).toEqual(before);
    expect(html(before)).not.toContain("Magnesium");

    const after = live();
    expect(after.catalogue).toHaveLength(20);
    const card = after.catalogue.find((p) => p.id === scenario.listing.productId);
    expect(card).toMatchObject({ ribbon: scenario.promo.ribbon, tag: "New", highlight: true, stock: { status: "in", label: "In stock" }, price: scenario.listing.price });
    expect(after.catalogue.filter((p) => p.highlight)).toHaveLength(1);
    expect(after.deals.products.map((p) => p.id)).toEqual(before.deals.products.map((p) => p.id));
  });

  it("opens on the product's category with the new card first, the sun-yellow ribbon and the rose highlight", () => {
    const out = html();
    const view = live();
    expect(view.published?.productIds).toEqual(scenario.storefront.publishedRow.productIds);
    expect(view.published?.breadcrumb).toEqual(["Home", scenario.storefront.publishedRow.category]);
    expect(out).toContain("Home › Vitamins &amp; supplements");
    expect(out).toMatch(/aria-current="page"[^>]*>Vitamins &amp; supplements</);
    const ids = [...out.matchAll(/data-product-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(scenario.storefront.publishedRow.productIds);
    expect(out).toMatch(/bg-promo[^>]*>2 for S\$55\.90</);
    expect(out).toMatch(/border-\[3px\] border-primary/);
    expect(out).toContain("data-highlight");
    expect(out).toContain(scenario.listing.title.split(" · ")[0]);
    expect(out).not.toContain("Wellness Week");
  });

  it("shows the live toast, the time to live and the search proof computed from the catalogue", () => {
    const view = live();
    const out = html(view);
    expect(out).toContain("data-live-toast");
    expect(out).toContain(scenario.published.toastTitle);
    expect(out).toContain(`Published 09:09 · approved by ${second.name}`);
    expect(out).toContain(`${scenario.launchApproval.approvalId} · ${scenario.listing.onlineStock} units online`);
    expect(out).toContain("Live in about 7 minutes");
    expect(view.published?.proof).toEqual({
      query: scenario.published.searchProof.query,
      before: scenario.published.searchProof.resultsBefore,
      after: scenario.published.searchProof.resultsAfter,
      afterLabel: "In stock",
    });
    expect(out).toContain("Before: <span");
    expect(out).toContain("0 results");
    expect(out).toContain("1 result, in stock");
    expect(searchCatalogue(view.catalogue, scenario.gap.query).map((p) => p.id)).toEqual([scenario.listing.productId]);
    expect(searchCatalogue(storefrontView(scenario).catalogue, scenario.gap.query)).toEqual([]);
  });

  it("counts the group chip from the catalogue and shows no toast without an approval", () => {
    const chips = live().published?.chips ?? [];
    expect(chips.map((c) => [c.label, c.count, c.kind])).toEqual([
      ["All", null, "all"],
      ["Multivitamins", null, "static"],
      ["Fish oil", null, "static"],
      ["Magnesium & minerals", 1, "group"],
      ["Gut health", null, "static"],
    ]);
    expect(html()).toContain("Magnesium &amp; minerals · 1");
    const noToast = storefrontView(scenario, { listed: true });
    expect(noToast.published?.toast).toBeNull();
    expect(html(noToast)).not.toContain("data-live-toast");
  });

  it("keeps violet and navy out of the storefront and takes every figure from the fixture", () => {
    const out = html();
    expect(out).not.toMatch(/(bg|text|border|stroke|fill)-(agent|human)/);
    expect(out).not.toMatch(/#5b3fd1|#1e3a8a/i);
    const edited = editedScenario((draft) => {
      draft.promo.ribbon = "2 for S$54.90";
      const item = draft.catalogue.find((c) => c.launchedInDemo);
      if (item) item.promo = { kind: "multibuy", ribbon: "2 for S$54.90" };
    });
    const view = storefrontView(edited, { listed: true });
    expect(renderToStaticMarkup(createElement(PelitaStorefront, { view }))).toContain("2 for S$54.90");
  });

  describe("the /demo/pelita page", () => {
    beforeEach(() => {
      useFakeRedis();
      openGate();
    });
    const page = async () => {
      const Page = (await import("@/app/demo/pelita/page")).default;
      const element = await Page();
      expect(isValidElement(element)).toBe(true);
      return (element as ReactElement<{ view: ReturnType<typeof storefrontView> }>).props.view;
    };

    it("reads the listed flag on every request: unlisted before approval 2, listed after, unlisted again after Reset", async () => {
      expect((await page()).published).toBeNull();
      await toScreen05();
      expect((await page()).published).toBeNull();
      await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
      const listed = await page();
      expect(listed.catalogue.map((p) => p.id)).toContain(scenario.listing.productId);
      expect(listed.published?.toast).toMatchObject({ line1: `Published 09:09 · approved by ${second.name}` });
      await resetDemo();
      expect(await page()).toEqual(storefrontView(scenario));
    });

    it("falls back to the unlisted storefront when the store is down", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
      expect(await page()).toEqual(storefrontView(scenario));
    });
  });
});

describe("screen 04 renders", () => {
  const view = (audit = scenario.audit.filter((r) => r.actorKind === "agent")) => listingDraftView(scenario, { audit });
  const noop = () => undefined;
  const render = (data = view(), status: "running" | "done" | "failed" = "done", error: string | null = null) =>
    renderToStaticMarkup(createElement(PelitaListingDraft, { data, status, error, busy: false, onRetry: noop, onEdit: async () => true, onSend: noop }));
  const button = (html: string, label: string) => {
    const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
    expect(match, label).not.toBeNull();
    return match![0];
  };
  const disabled = /\sdisabled(=""|\s|>)/;

  it("shows the preview, the agent's fields and the claims check, with Edit enabled", () => {
    const html = render();
    const text = html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    expect(html).toContain("data-listing-draft");
    expect(html).toContain("SHOPPER PREVIEW");
    expect(html).toContain("Not live yet");
    expect(html).toContain("DRAFTED BY SHELF AGENT · REVIEW BEFORE SENDING");
    expect(html).toMatch(/bg-promo[^>]*data-promo-ribbon[^>]*>2 for S\$55\.90</);
    for (const value of [scenario.listing.title, scenario.listing.description, scenario.listing.category, scenario.promo.runsLabel, "Claims check passed"]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("Removed: “cures insomnia” (medicinal claim)");
    expect(html).toContain("data-claim-diff");
    expect(html).toContain("line-through");
    expect(text).toContain("supports relaxation and restful sleep");
    expect(text).toContain(scenario.claimsCheck.disclaimer);
    expect(button(html, "Edit")).not.toMatch(disabled);
    expect(button(html, "Send for approval →")).not.toMatch(disabled);
  });

  it("is violet for the agent, rose for sending, and never navy, which stays for the approvals", () => {
    const html = render();
    expect(html).toContain("text-agent");
    expect(html).toContain("shadow-[inset_8px_0_0_var(--color-agent)]");
    expect(button(html, "Send for approval →")).toContain("bg-primary");
    expect(html).not.toMatch(/(text|bg|border|ring|accent)-human|#1E3A8A/i);
    expect(readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaListingDraft.tsx"), "utf8")).not.toMatch(/-human|HumanIcon|#1E3A8A/i);
    expect(readFileSync(path.join(ROOT, "src/components/pelita-ops/PelitaLaunchApproval.tsx"), "utf8")).not.toMatch(/(text|bg|border|ring|accent)-agent|#5B3FD1|violet|purple|SparkleIcon/i);
  });

  it("shows a checking state with both buttons off while the draft runs, and Retry when it failed", () => {
    const running = render(view([]), "running");
    expect(running).toContain('aria-busy="true"');
    expect(running).toContain("Drafting the listing and checking claims…");
    expect(running).not.toContain(scenario.listing.description);
    expect(button(running, "Edit")).toMatch(disabled);
    expect(button(running, "Send for approval →")).toMatch(disabled);

    const failed = render(view([]), "failed", "The claims check did not pass. Try again.");
    expect(button(failed, "Retry")).not.toMatch(disabled);
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("Send for approval →");
  });

  it("tags an edited description with who edited it", async () => {
    await (async () => {
      useFakeRedis();
      await toScreen04();
      await runListingDraft(scenario, instantDeps());
      await editListing(scenario, { approverId: first.id, description: "A calmer wording." }, T_EDIT);
    })();
    const data = listingDraftView(scenario, await getDemoState());
    const html = render(data);
    expect(html).toContain("data-edited-tag");
    expect(html).toContain(`Edited by ${first.name}`);
    expect(html).toContain("A calmer wording.");
    expect(render()).not.toContain("data-edited-tag");
  });

  it("screen 05 shows an edit as old → new and, once published, the live outcome with a storefront link", async () => {
    useFakeRedis();
    await toScreen04();
    await runListingDraft(scenario, instantDeps());
    await editListing(scenario, { approverId: first.id, description: "A calmer wording." }, T_EDIT);
    await sendForApproval(scenario, { approverId: first.id }, T_SEND);
    const state = await getDemoState();
    const approval = approvalView(scenario, state);
    const common = {
      data: approval.launch,
      actor: approval.approvers[1],
      sourcing: approval.recorded.sourcing,
      launch: null,
      sentBack: null,
      busy: false,
      error: null,
      onApprove: noop,
      onSendBack: noop,
    };
    const pending = renderToStaticMarkup(createElement(PelitaLaunchApproval, { ...common, phase: "launch_pending", published: null }));
    expect(pending).toContain("data-old-value");
    expect(pending).toContain(scenario.listing.description);
    expect(pending).toContain("A calmer wording.");

    const result = await approveLaunch(scenario, { approverId: second.id, confirmed: true }, T2);
    const published = result.ok ? result.published : null;
    const outcome = renderToStaticMarkup(createElement(PelitaLaunchApproval, { ...common, phase: "launched", launch: result.ok ? result.approval : null, published }));
    expect(outcome).toContain("data-launch-published");
    expect(outcome).toContain(scenario.published.toastTitle);
    expect(outcome).toContain("Live in about 7 minutes");
    expect(outcome).toContain('href="/demo/pelita"');
    expect(outcome).not.toContain("Approve and publish");
    expect(outcome).not.toMatch(/(text|bg|border|ring|accent)-agent/);
  });

  it("the console shows screen 04 with step 4 outlined violet", () => {
    const state = { stage: 4, approvals: { sourcing: { approvalId: scenario.sourcing.approvalId, approverId: first.id, at: T1.toISOString() } }, audit: scenario.audit.filter((r) => r.actorKind === "agent") };
    const html = renderToStaticMarkup(
      createElement(PelitaOpsConsole, { view: opsConsoleView(scenario, state), approval: approvalView(scenario, state), listing: listingDraftView(scenario, state) }),
    );
    expect(html).toContain("data-listing-draft");
    const current = /<li aria-current="step"[^>]*>(.*?)<\/li>/.exec(html);
    expect(current?.[1]).toContain("Draft listing");
    expect(current?.[0]).toContain("border-agent");
    expect(approvalView(scenario, state).defaultActorId).toBe(first.id);
  });
});

describe("listing API", () => {
  it("answers 404 when the gate is closed, the cookie is missing, or on production", async () => {
    const body = { action: "draft" };
    expect((await listingRoute(post(LISTING_URL, body))).status).toBe(404);
    openGate();
    expect((await listingRoute(post(LISTING_URL, body, { cookie: false }))).status).toBe(404);
    process.env.VERCEL_ENV = "production";
    expect((await listingRoute(post(LISTING_URL, body))).status).toBe(404);
  });

  it("refuses cross-site writes, unknown actions, missing people and bad bodies, and 503s without a store", async () => {
    openGate();
    expect((await listingRoute(post(LISTING_URL, { action: "draft" }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await listingRoute(post(LISTING_URL, { action: "publish" }))).status).toBe(400);
    expect((await listingRoute(post(LISTING_URL, { action: "send" }))).status).toBe(400);
    expect((await listingRoute(post(LISTING_URL, { action: "edit", approverId: first.id }))).status).toBe(400);
    expect((await listingRoute(post(LISTING_URL, null))).status).toBe(400);
    const garbled = new Request(LISTING_URL, {
      method: "POST",
      headers: { origin: "https://x.test", cookie: `${PRESENTER_COOKIE}=${signPresenterToken(SECRET)}` },
      body: "{nope",
    });
    expect((await listingRoute(garbled)).status).toBe(400);
    expect((await listingRoute(post(LISTING_URL, { action: "draft" }))).status).toBe(503);
  });

  it("runs end to end through the routes: draft, edit, send, publish, then Reset", async () => {
    openGate();
    useFakeRedis();
    const waits: number[] = [];
    setListingDeps({ wait: async (ms) => void waits.push(ms), now: () => T_DRAFT });
    const call = (body: Record<string, unknown>) => listingRoute(post(LISTING_URL, body));
    const approve = (action: string, approverId: string) => approvalRoute(post(APPROVAL_URL, { action, approverId, confirmed: true }));

    const early = await call({ action: "draft" });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: "sourcing_required" });
    await toScreen04();
    expect((await call({ action: "send", approverId: first.id })).status).toBe(409);

    const draft = await call({ action: "draft" });
    expect(draft.status).toBe(200);
    expect(draft.headers.get("cache-control")).toBe("private, no-store");
    expect(await draft.json()).toMatchObject({ isDemo: true, ok: true, changed: true, phase: "listing_draft", draft: { isDemo: true, complete: true } });
    expect(waits).toHaveLength(1);

    const dirty = await call({ action: "edit", approverId: first.id, description: "Cures insomnia fast." });
    expect(dirty.status).toBe(422);
    expect(await dirty.json()).toEqual({ error: "claim_not_allowed" });
    expect((await call({ action: "edit", approverId: first.id, description: "" })).status).toBe(400);
    const edited = await call({ action: "edit", approverId: first.id, description: "A calmer wording." });
    expect(await edited.json()).toMatchObject({ ok: true, changed: true, draft: { description: { value: "A calmer wording.", edited: { by: first.name } } } });

    expect((await approve("approve_launch", second.id)).status).toBe(409);
    const send = await call({ action: "send", approverId: first.id });
    expect(await send.json()).toMatchObject({ ok: true, phase: "launch_pending", launch: { diff: expect.arrayContaining([expect.objectContaining({ label: "Description", old: scenario.listing.description })]) } });
    expect((await call({ action: "edit", approverId: first.id, description: "Too late." })).status).toBe(409);

    const publish = await approve("approve_launch", second.id);
    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({ phase: "launched", published: { liveIn: "Live in about 7 minutes" } });
    expect((await getDemoState()).listed).toBe(true);

    expect((await resetRoute(post("https://x.test/api/demo/pelita/reset", undefined))).status).toBe(200);
    expect(await getDemoState()).toEqual({ stage: 0, approvals: {}, audit: [], listed: false });
  });

  it("maps a claims-check failure to 502 and a store outage to 503", async () => {
    openGate();
    useFakeRedis();
    await toScreen04();
    setListingDeps({ claims: async (s, d) => ({ ...(await mockClaimsCheck(s, d)), status: "failed" as never }) });
    const failed = await listingRoute(post(LISTING_URL, { action: "draft" }));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "claims_failed" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect((await listingRoute(post(LISTING_URL, { action: "send", approverId: first.id }))).status).toBe(503);
  });
});

describe("listing and publish code holds no fixture figures, and touches no identity provider", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const CHANGED_FILES = [
    ...NEW_FILES,
    "src/lib/demo/approval.ts",
    "src/lib/demo/approval-view.ts",
    "src/lib/demo/approval-client.ts",
    "src/lib/demo/storefront.ts",
    "src/lib/demo/stock-check.ts",
    "src/components/pelita-ops/PelitaLaunchApproval.tsx",
    "src/components/pelita-ops/PelitaOpsConsole.tsx",
    "src/components/pelita/PelitaStorefront.tsx",
    "src/components/pelita/PelitaProductCard.tsx",
    "src/app/demo/pelita/page.tsx",
    "src/app/demo/pelita/ops/page.tsx",
  ];

  it("has no hardcoded names, ids, amounts, promo copy or claim wording", () => {
    const fixtureValues = [
      ...scenario.approvers.flatMap((a) => [a.name, a.id, a.approvalId, a.role]),
      scenario.promo.ribbon,
      scenario.promo.runsLabel,
      scenario.listing.title,
      scenario.listing.description,
      scenario.listing.category,
      scenario.listing.unitPrice,
      scenario.proposal.supplier,
      scenario.claimsCheck.id,
      scenario.claimsCheck.ruleset,
      scenario.claimsCheck.disclaimer,
      scenario.purchaseOrder.id,
      scenario.listing.id,
      scenario.published.toastTitle,
      scenario.published.searchProof.query,
      scenario.timing.totalLabel,
      ...scenario.claimsCheck.removed.flatMap((r) => [r.claim, r.reason]),
      ...scenario.claimsCheck.kept,
      ...scenario.audit.filter((r) => r.actorKind !== "human").flatMap((r) => [r.action, r.actor, r.source]),
    ];
    const longValues = fixtureValues.filter((value) => value.length >= 12);
    const figures = [
      scenario.sourcing.spendLimit,
      scenario.sourcing.maxUnits,
      scenario.promo.bundlePrice,
      scenario.promo.projectedWeek1Sales,
      scenario.promo.marginPct,
      scenario.promo.marginFloorPct,
      scenario.promo.perUnit,
      scenario.listing.onlineStock,
      scenario.erp.moveToOnline,
      scenario.proposal.price,
      scenario.timing.totalSeconds,
      scenario.gap.searches,
    ].filter((n) => String(n).length >= 3).map((n) => String(n).replace(/\./g, "\\.").replace(/(\d)(?=(\d{3})+$)/g, "$1,?"));
    for (const file of CHANGED_FILES) {
      const text = read(file);
      for (const value of longValues) expect(text, `${file}: ${value}`).not.toContain(value);
      for (const figure of figures) expect(text, `${file}: ${figure}`).not.toMatch(new RegExp(`(?<![\\w.-])${figure}(?![\\w.])`));
      expect(text, file).not.toMatch(/APR-\d|PO-\d|CMP-\d|LST-\d|PRP-\d|S\$\d|cures insomnia|Priya|Daniel|Mei Ling|Arjun|Evergreen|Tuas/);
    }
  });

  it("makes no identity-provider, database or env access, and the browser calls only the listing route", () => {
    for (const file of CHANGED_FILES) {
      expect(read(file), file).not.toMatch(/auth0|management|@neondatabase|bi-db|bi-events|process\.env|redisPipeline|from "\.\.?\/(\.\.\/)?upstash"/i);
    }
    const client = read("src/lib/demo/listing-client.ts");
    expect([...client.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1])).toEqual(["/api/demo/pelita/listing"]);
    for (const file of NEW_FILES.filter((f) => f !== "src/lib/demo/listing-client.ts")) {
      expect(read(file), file).not.toMatch(/\bfetch\(/);
    }
  });

  it("the logic modules import only other demo modules, and the route guards the write and the pages guard the gate", () => {
    for (const file of ["src/lib/demo/listing.ts", "src/lib/demo/listing-view.ts", "src/lib/demo/published-view.ts"]) {
      for (const match of read(file).matchAll(/^import .* from "([^"]+)";$/gm)) expect(match[1], file).toMatch(/^\.\//);
    }
    expect(read("src/app/api/demo/pelita/listing/route.ts")).toMatch(/guardDemoWrite\(req\)/);
    expect(read("src/app/api/demo/pelita/approval/route.ts")).toMatch(/guardDemoWrite\(req\)/);
    expect(read("src/app/demo/pelita/page.tsx")).toMatch(/await requirePresenterPage\(\)/);
    expect(read("src/app/demo/pelita/ops/page.tsx")).toMatch(/await requirePresenterPage\(\)/);
  });

  it("uses the colour tokens: violet only for the agent screens, navy only for approvals, sun-yellow for ribbons", () => {
    const draft = read("src/components/pelita-ops/PelitaListingDraft.tsx");
    expect(draft).toMatch(/bg-promo/);
    expect(draft).not.toMatch(/bg-human|text-human/);
    const card = read("src/components/pelita/PelitaProductCard.tsx");
    expect(card).toMatch(/bg-promo/);
    expect(card).not.toMatch(/-(agent|human)/);
    expect(scenario.brand.palette).toMatchObject({ agent: "#5B3FD1", human: "#1E3A8A", promo: "#FFC93C" });
    const css = read("src/app/globals.css");
    expect(css).toMatch(/--color-agent:\s*#5b3fd1/i);
    expect(css).toMatch(/--color-human:\s*#1e3a8a/i);
    expect(css).toMatch(/--color-promo:\s*#ffc93c/i);
  });
});
