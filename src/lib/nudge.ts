import products from "@/data/products.json";
import { recommendAddedProductIds } from "./bi-shopper";
import { biSessionId } from "./bi-track";
import { getProduct } from "./cart";
import { productImageUrl } from "./images";
import { estimateReorder, suggestNextBean, type NudgeProduct } from "./reorder-nudge";
import { markNudgeSession } from "./agent-prefs";
import { readNudgeInputs, type NudgeInputs } from "./store-meta";
import type { AgentPrefs } from "./store-types";
import type { Product } from "./types";

const catalog = products as Product[];

export type NudgeChoice = "both" | "reorder";
export type NudgeLine = { productId: string; qty: number };

export type NudgeCard = {
  kind: "reorder" | "new_bean";
  lines: NudgeLine[];
  name: string;
  image: string;
  priceCents: number;
  grams: number;
  tag: string;
  /** Why Barista is showing this card. The reorder reason states the g/day assumption. */
  reason: string;
};

export type Nudge = {
  message: string;
  reorder: NudgeCard;
  newBean: NudgeCard | null;
  gramsPerDay: number;
  /** Shopper is a test or demo shopper, so the UI labels the data. */
  demo: boolean;
};

export type NudgeSkip = "paused" | "snoozed" | "already_shown" | "no_history" | "not_due";

export type NudgeResult = { nudge: Nudge; skip?: undefined } | { nudge: null; skip: NudgeSkip };

/** Pure gate: paused, snoozed, or already shown in this browser session. */
export function nudgeGate(prefs: AgentPrefs, session: string | null, now: Date): NudgeSkip | null {
  if (prefs.paused) return "paused";
  if (prefs.snoozeUntil && new Date(prefs.snoozeUntil).getTime() > now.getTime()) return "snoozed";
  if (session && prefs.lastNudgeSession === session) return "already_shown";
  return null;
}

function card(kind: NudgeCard["kind"], lines: NudgeLine[], tag: string, reason: string): NudgeCard | null {
  const known = lines.flatMap((line) => {
    const product = getProduct(line.productId);
    return product ? [{ line, product }] : [];
  });
  const first = known[0];
  if (!first) return null;
  const extra = known.length - 1;
  return {
    kind,
    lines: known.map(({ line }) => line),
    name: extra > 0 ? `${first.product.name} + ${extra} more` : first.product.name,
    image: productImageUrl(first.product.id),
    priceCents: known.reduce((sum, { line, product }) => sum + product.price * line.qty, 0),
    grams: known.reduce((sum, { line, product }) => sum + (product.attributes?.grams ?? 0) * line.qty, 0),
    tag,
    reason,
  };
}

/** Pure: builds the nudge from a shopper's orders and the products they added from recommendations. */
export function buildNudge(inputs: NudgeInputs, recommendAdded: readonly string[], now: Date): NudgeResult {
  const nudgeProducts: NudgeProduct[] = catalog;
  const estimate = estimateReorder(inputs.orders, nudgeProducts, { now });
  if (!estimate) return { nudge: null, skip: "no_history" };
  if (!estimate.due) return { nudge: null, skip: "not_due" };

  const order = inputs.orders.find((row) => row.id === estimate.orderId);
  const lines: NudgeLine[] = (order?.items ?? [])
    .filter((item) => estimate.productIds.includes(item.productId))
    .map((item) => ({ productId: item.productId, qty: item.qty }));
  const days = estimate.daysSinceOrder;
  const reorder = card("reorder", lines, `Usual, ${days} ${days === 1 ? "day" : "days"} ago`, estimate.reason);
  if (!reorder) return { nudge: null, skip: "no_history" };

  const suggestion = suggestNextBean(inputs.orders, nudgeProducts, recommendAdded, { now });
  const newBean =
    suggestion && !estimate.productIds.includes(suggestion.productId)
      ? card("new_bean", [{ productId: suggestion.productId, qty: 1 }], "New for you", suggestion.reason)
      : null;

  const message =
    `Your ${reorder.name} is probably running low. You ordered it ${days} ${days === 1 ? "day" : "days"} ago. Want me to reorder?` +
    (newBean ? ` I think you'd also like ${newBean.name}.` : "");
  return {
    nudge: { message, reorder, newBean, gramsPerDay: estimate.gramsPerDay, demo: inputs.demo },
  };
}

/**
 * The nudge to show for this chat session, or why there is none. Marks the session as
 * nudged (`agent_prefs.lastNudgeSession`) only when a nudge is returned.
 */
export async function nextNudge(userId: string, rawSession: unknown, now = new Date()): Promise<NudgeResult> {
  const session = biSessionId(rawSession);
  const inputs = await readNudgeInputs(userId);
  const skip = nudgeGate(inputs.flags.agentPrefs, session, now);
  if (skip) return { nudge: null, skip };
  const result = buildNudge(inputs, await recommendAddedProductIds(userId), now);
  if (result.nudge && session) await markNudgeSession(userId, session);
  return result;
}

/** Cart lines for the chip the shopper picked, re-derived on the server. Null when paused or no nudge applies. */
export async function nudgeLines(
  userId: string,
  choice: NudgeChoice,
  now = new Date(),
): Promise<{ lines: NudgeLine[] } | { error: "paused" | "no_nudge" }> {
  const inputs = await readNudgeInputs(userId);
  if (inputs.flags.agentPrefs.paused) return { error: "paused" };
  const result = buildNudge(inputs, await recommendAddedProductIds(userId), now);
  if (!result.nudge) return { error: "no_nudge" };
  const lines = [...result.nudge.reorder.lines, ...(choice === "both" && result.nudge.newBean ? result.nudge.newBean.lines : [])];
  return { lines };
}
