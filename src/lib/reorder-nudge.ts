import type { BeanAttributes, Product } from "./types";

/** The slice of a stored order the nudge engine reads (see store-meta.ts). */
export type NudgeOrder = {
  createdAt: string;
  cancelledAt?: string | null;
  items: { productId: string; qty: number }[];
};

export type NudgeProduct = Pick<Product, "id" | "name" | "category" | "attributes">;

export const DEFAULT_GRAMS_PER_DAY = 15;
export const DUE_WITHIN_DAYS = 3;
export const RECENT_BUY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReorderEstimate = {
  orderId?: string;
  productIds: string[];
  orderedAt: string;
  daysSinceOrder: number;
  gramsBought: number;
  gramsPerDay: number;
  /** Negative once the estimated supply has run out. */
  estimatedDaysLeft: number;
  due: boolean;
  reason: string;
};

export type NextBeanSuggestion = {
  productId: string;
  name: string;
  addedCount: number;
  similarity: number;
  reason: string;
};

type BoughtBean = { product: NudgeProduct & { attributes: BeanAttributes }; qty: number; at: number };

function beanOf(product: NudgeProduct | undefined): (NudgeProduct & { attributes: BeanAttributes }) | null {
  if (!product || product.category !== "beans" || !product.attributes) return null;
  return product as NudgeProduct & { attributes: BeanAttributes };
}

function usableOrders(orders: readonly (NudgeOrder & { id?: string })[] | null | undefined) {
  const rows: { order: NudgeOrder & { id?: string }; at: number }[] = [];
  for (const order of orders ?? []) {
    if (!order || order.cancelledAt) continue;
    const at = new Date(order.createdAt).getTime();
    if (Number.isNaN(at)) continue;
    rows.push({ order, at });
  }
  return rows;
}

function boughtBeans(orders: readonly NudgeOrder[] | null | undefined, products: readonly NudgeProduct[]): BoughtBean[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const bought: BoughtBean[] = [];
  for (const { order, at } of usableOrders(orders)) {
    for (const item of order.items ?? []) {
      const product = beanOf(byId.get(item.productId));
      if (!product || !Number.isInteger(item.qty) || item.qty < 1) continue;
      bought.push({ product, qty: item.qty, at });
    }
  }
  return bought;
}

function dayWord(days: number): string {
  return Math.abs(days) === 1 ? "day" : "days";
}

/**
 * Estimates when the shopper runs out of their most recent bean order.
 * Cancelled orders and non-bean lines are ignored. Returns null when there is
 * no bean order to estimate from.
 */
export function estimateReorder(
  orders: readonly (NudgeOrder & { id?: string })[] | null | undefined,
  products: readonly NudgeProduct[],
  options: { now: Date; gramsPerDay?: number },
): ReorderEstimate | null {
  const gramsPerDay =
    Number.isFinite(options.gramsPerDay) && (options.gramsPerDay as number) > 0
      ? (options.gramsPerDay as number)
      : DEFAULT_GRAMS_PER_DAY;
  const byId = new Map(products.map((p) => [p.id, p]));

  let latest: { order: NudgeOrder & { id?: string }; at: number; beans: BoughtBean[] } | null = null;
  for (const { order, at } of usableOrders(orders)) {
    if (latest && at <= latest.at) continue;
    const beans: BoughtBean[] = [];
    for (const item of order.items ?? []) {
      const product = beanOf(byId.get(item.productId));
      if (!product || !Number.isInteger(item.qty) || item.qty < 1) continue;
      beans.push({ product, qty: item.qty, at });
    }
    if (beans.length > 0) latest = { order, at, beans };
  }
  if (!latest) return null;

  const gramsBought = latest.beans.reduce((sum, b) => sum + b.product.attributes.grams * b.qty, 0);
  const daysSinceOrder = Math.max(0, Math.floor((options.now.getTime() - latest.at) / DAY_MS));
  const supplyDays = gramsBought / gramsPerDay;
  const estimatedDaysLeft = Math.ceil(supplyDays - daysSinceOrder) + 0;
  const due = estimatedDaysLeft <= DUE_WITHIN_DAYS;

  const names = [...new Set(latest.beans.map((b) => b.product.name))].join(", ");
  const assumption = `assuming ~${gramsPerDay} g/day`;
  let outlook: string;
  if (estimatedDaysLeft > 0) {
    outlook = `about ${estimatedDaysLeft} ${dayWord(estimatedDaysLeft)} left`;
  } else if (estimatedDaysLeft === 0) {
    outlook = "likely running out today";
  } else {
    const over = -estimatedDaysLeft;
    outlook = `likely ran out ${over} ${dayWord(over)} ago`;
  }
  const reason =
    `You bought ${gramsBought} g (${names}) ${daysSinceOrder} ${dayWord(daysSinceOrder)} ago; ` +
    `${assumption}, that is ${outlook}.` +
    (due ? " Time to reorder." : "");

  return {
    orderId: latest.order.id,
    productIds: [...new Set(latest.beans.map((b) => b.product.id))],
    orderedAt: new Date(latest.at).toISOString(),
    daysSinceOrder,
    gramsBought,
    gramsPerDay,
    estimatedDaysLeft,
    due,
    reason,
  };
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function similarity(candidate: BeanAttributes, reference: BeanAttributes) {
  const sameRoast = candidate.roast === reference.roast;
  const sameOrigin = normalized(candidate.origin) === normalized(reference.origin);
  const refNotes = new Set(reference.notes.map(normalized));
  const sharedNotes = [...new Set(candidate.notes.map(normalized))].filter((n) => refNotes.has(n));
  const score = (sameRoast ? 1 : 0) + (sameOrigin ? 1 : 0) + sharedNotes.length;
  return { score, sameRoast, sameOrigin, sharedNotes };
}

/**
 * Picks a bean the shopper has not bought in the last `recentDays`, ranked by
 * how often they added it from a recommendation, then by attribute similarity
 * to beans they have bought (best single match). Ties keep catalog order.
 * Returns null when no candidate bean remains.
 */
export function suggestNextBean(
  orders: readonly NudgeOrder[] | null | undefined,
  products: readonly NudgeProduct[],
  recommendAddedProductIds: readonly string[] | null | undefined,
  options: { now: Date; recentDays?: number },
): NextBeanSuggestion | null {
  const recentDays = options.recentDays ?? RECENT_BUY_DAYS;
  const cutoff = options.now.getTime() - recentDays * DAY_MS;
  const bought = boughtBeans(orders, products);
  const recentIds = new Set(bought.filter((b) => b.at >= cutoff).map((b) => b.product.id));

  const added = new Map<string, number>();
  for (const id of recommendAddedProductIds ?? []) added.set(id, (added.get(id) ?? 0) + 1);

  const references = new Map(bought.map((b) => [b.product.id, b.product]));
  let best: { product: NudgeProduct & { attributes: BeanAttributes }; addedCount: number; match: ReturnType<typeof similarity> & { to?: string } } | null = null;

  for (const raw of products) {
    const product = beanOf(raw);
    if (!product || recentIds.has(product.id)) continue;
    const addedCount = added.get(product.id) ?? 0;
    let match: ReturnType<typeof similarity> & { to?: string } = { score: 0, sameRoast: false, sameOrigin: false, sharedNotes: [] };
    for (const ref of references.values()) {
      if (ref.id === product.id) continue;
      const m = similarity(product.attributes, ref.attributes);
      if (m.score > match.score) match = { ...m, to: ref.name };
    }
    if (!best || addedCount > best.addedCount || (addedCount === best.addedCount && match.score > best.match.score)) {
      best = { product, addedCount, match };
    }
  }
  if (!best) return null;

  const parts: string[] = [];
  if (best.addedCount > 0) {
    parts.push(`you added it from a recommendation ${best.addedCount} ${best.addedCount === 1 ? "time" : "times"} before`);
  }
  const { match } = best;
  if (match.score > 0 && match.to) {
    const shared: string[] = [];
    if (match.sameRoast) shared.push(`${best.product.attributes.roast} roast`);
    if (match.sameOrigin) shared.push(`${best.product.attributes.origin} origin`);
    if (match.sharedNotes.length > 0) shared.push(`${match.sharedNotes.join(", ")} notes`);
    parts.push(`it is similar to ${match.to} (${shared.join(", ")})`);
  }
  const reason =
    parts.length > 0
      ? `Suggested ${best.product.name}: ${parts.join(" and ")}.`
      : `Suggested ${best.product.name}: a bean you have not tried recently.`;

  return {
    productId: best.product.id,
    name: best.product.name,
    addedCount: best.addedCount,
    similarity: match.score,
    reason,
  };
}
