import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { biId, biSessionId, emitBi, lookupShownRecommendation, trackAdded } from "./bi-track";
import { getProduct } from "./cart";
import { findCoupon } from "./coupons";
import { safeEqual } from "./github-signature";
import { tooManyFeedbackReports } from "./rate-limit";
import { reporterBlock, type Shopper } from "./shopper";
import { StoreUnavailableError } from "./store-error";
import {
  addManyToCart,
  addToCart,
  applyCoupon,
  cancelOrder,
  getCart,
  getOrder,
  getShopperFlags,
  placeOrder,
  removeFromCart,
  setCartQty,
} from "./store-meta";
import { undoDeadline } from "./order-status";
import { bestEffort, newActivityId, recordActivity, type ActivityChange } from "./agent-activity";
import { BARISTA } from "./agent-activity-text";
import type { CartSnapshot } from "./store-types";
import { consumeNonce, issueNonce, rearmNonce, rememberedLines } from "./upstash";

/** Confirm tokens last five minutes and can be used once. */
export const ACTION_TTL_SEC = 300;

/** One Confirm may add at most this many distinct lines. */
export const MAX_MANY_LINES = 5;

const Qty = z.number().int().min(1).max(99);
const ProductId = z.string().trim().min(1).max(80);
const RecommendationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const ManyLine = z.strictObject({ productId: ProductId, qty: Qty });

export const ActionBody = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add_to_cart"),
    productId: ProductId,
    qty: Qty.optional(),
    recommendationId: RecommendationId.optional(),
  }),
  z.strictObject({ op: z.literal("add_many"), lines: z.array(ManyLine).min(1).max(MAX_MANY_LINES) }),
  z.strictObject({ op: z.literal("update_cart_qty"), productId: ProductId, qty: Qty }),
  z.strictObject({ op: z.literal("remove_from_cart"), productId: ProductId, qty: Qty.optional() }),
  z.strictObject({ op: z.literal("apply_coupon"), code: z.string().trim().min(1).max(40) }),
  z.strictObject({ op: z.literal("place_order"), anyway: z.literal(true).optional() }),
  z.strictObject({ op: z.literal("cancel_order"), orderId: z.string().trim().min(1).max(40) }),
  z.strictObject({ op: z.literal("report_problem"), message: z.string().trim().min(5).max(2000) }),
]);

export type ShopAction = z.infer<typeof ActionBody>;

type SignedAction = {
  typ: "action";
  sub: string;
  exp: number;
  jti: string;
  summary: string;
  action: ShopAction;
  cartHash?: string;
  /** Chat session bound at propose time. Set only with a verified recommendation id. */
  sessionId?: string;
  /** Audit entry this action continues. Set only on the server's own over-cap step. */
  activityId?: string;
  /** Why Barista is acting, for the audit trail. Carried so a follow-up step keeps it. */
  reason?: string;
};

export type PendingAction = { pending: true; actionId: string; summary: string };

/** A follow-up step signed in the same Confirm: the cart as it now stands and a signed place_order. */
export type NextStep = {
  actionId: string;
  summary: string;
  cart: { lines: { productId: string; name: string; qty: number; unitPriceCents: number }[]; totalCents: number };
};

/** The order a confirmed place_order created, with when it can no longer be undone. */
export type PlacedOrder = {
  id: string;
  createdAt: string;
  totalCents: number;
  lines: { name: string; qty: number; unitPriceCents: number }[];
  undoUntil: string;
};

/** Nothing was placed: the order is over the shopper's cap, so a second signed step asks again. */
export type OverCap = { actionId: string; summary: string; totalCents: number; capCents: number };

export type CommitResult =
  | {
      ok: true;
      summary: string;
      report?: { feedback: string; reportedBy: string };
      next?: NextStep;
      order?: PlacedOrder;
      overCap?: OverCap;
      /** The audit entry this commit completes. The confirm route applies it after the write succeeds. */
      audit?: { id: string; change: ActivityChange };
    }
  | { ok: false; status: number; error: string; message: string };

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function secret(): string {
  const value = process.env.APPROVAL_SECRET?.trim() ?? "";
  if (!value) throw new StoreUnavailableError();
  return value;
}

/** Separate MAC key so a confirm action cannot verify as a support bearer token. */
export function actionKey(rawSecret: string): string {
  return createHmac("sha256", rawSecret).update("action-v1").digest("base64url");
}

function fail(status: number, error: string, message = error): CommitResult {
  return { ok: false, status, error, message };
}

/** True when `code` is its own word in a line the shopper typed. */
export function codeAppearsIn(code: string, lines: readonly string[]): boolean {
  const want = code.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(want)) return false;
  return lines.some((line) => line.toUpperCase().split(/[^A-Z0-9]+/).includes(want));
}

function folded(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when the report text is one whole typed line, or consecutive typed
 * lines joined in order, after case and whitespace are normalised.
 */
export function textAppearsIn(text: string, lines: readonly string[]): boolean {
  const want = folded(text);
  if (want.length < 5) return false;
  const typed = lines.map(folded).filter(Boolean);
  for (let start = 0; start < typed.length; start++) {
    let joined = "";
    for (let end = start; end < typed.length; end++) {
      joined = joined ? `${joined} ${typed[end]}` : typed[end] ?? "";
      if (joined === want) return true;
    }
  }
  return false;
}

function cartFingerprint(cart: CartSnapshot): string {
  const payload = JSON.stringify({
    items: cart.items.map((item) => [item.productId, item.qty]),
    coupon: cart.coupon,
    totalCents: cart.totalCents,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function sign(claims: SignedAction, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function signActionToken(claims: SignedAction, rawSecret: string): string {
  return sign(claims, actionKey(rawSecret));
}

export function verifyAction(token: string, rawSecret: string, nowMs = Date.now()): SignedAction | null {
  if (!rawSecret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", actionKey(rawSecret)).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SignedAction>;
    if (claims.typ !== "action") return null;
    if (typeof claims.sub !== "string" || !claims.sub.trim()) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
    if (typeof claims.jti !== "string" || !claims.jti) return null;
    if (typeof claims.summary !== "string" || !claims.summary) return null;
    const action = ActionBody.safeParse(claims.action);
    if (!action.success) return null;
    if (action.data.op === "place_order" && (typeof claims.cartHash !== "string" || !claims.cartHash)) return null;
    const sessionId = biSessionId(claims.sessionId);
    const activityId = typeof claims.activityId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(claims.activityId) ? claims.activityId : undefined;
    const reason = typeof claims.reason === "string" && claims.reason.trim() ? claims.reason.trim().slice(0, 200) : undefined;
    return {
      typ: "action",
      sub: claims.sub,
      exp: claims.exp,
      jti: claims.jti,
      summary: claims.summary,
      action: signedAction(action.data),
      cartHash: claims.cartHash,
      ...(sessionId ? { sessionId } : {}),
      ...(activityId ? { activityId } : {}),
      ...(reason ? { reason } : {}),
    };
  } catch {
    return null;
  }
}

/** Signed summary for this shopper, or nothing when the action id does not verify. */
export function confirmedCard(userId: string, actionId: string, rawSecret: string): { actionId: string; summary: string } | undefined {
  const claims = verifyAction(actionId, rawSecret);
  if (!claims || claims.sub !== userId) return undefined;
  return { actionId, summary: claims.summary };
}

async function summaryFor(userId: string, action: ShopAction): Promise<string | { error: string }> {
  if (action.op === "add_to_cart" || action.op === "update_cart_qty" || action.op === "remove_from_cart") {
    const product = getProduct(action.productId);
    if (!product) return { error: "unknown_product" };
    const qty = action.op === "update_cart_qty" ? action.qty : (action.qty ?? 1);
    const price = money(product.price);
    if (action.op === "add_to_cart") {
      return `Add ${qty} ${product.name} at ${price} each. The price is from the catalogue. Press Confirm to add it.`;
    }
    if (action.op === "update_cart_qty") {
      return `Set ${product.name} quantity to ${qty} at ${price} each. The price is from the catalogue. Press Confirm to update it.`;
    }
    return `Remove ${qty} ${product.name} from the cart. Press Confirm to remove it.`;
  }
  if (action.op === "add_many") {
    const parts: string[] = [];
    for (const line of action.lines) {
      const product = getProduct(line.productId);
      if (!product) return { error: "unknown_product" };
      parts.push(`${line.qty} ${product.name} at ${money(product.price)}`);
    }
    return `Add ${parts.join(" and ")} to your cart. Prices are from the catalogue. Press Confirm to add them.`;
  }
  if (action.op === "apply_coupon") {
    const coupon = findCoupon(action.code);
    if (!coupon) return { error: "invalid_coupon" };
    const lines = await rememberedLines(userId);
    if (!codeAppearsIn(action.code, lines)) return { error: "coupon_not_typed" };
    return `Apply the coupon code you typed (${coupon.code}). Press Confirm to apply it.`;
  }
  if (action.op === "place_order") {
    const cart = await getCart(userId);
    if (cart.items.length === 0) return { error: "empty_cart" };
    if (action.anyway) {
      const { agentPrefs } = await getShopperFlags(userId);
      return `Place it anyway? This order is ${money(cart.totalCents)}, over your ${money(agentPrefs.capCents)} cap per order. Press Confirm to place it anyway.`;
    }
    const discount = cart.discountCents > 0 ? " A discount is applied." : "";
    return `Place your order. Catalogue total ${money(cart.totalCents)}.${discount} Press Confirm to place it.`;
  }
  if (action.op === "cancel_order") {
    const order = await getOrder(userId, action.orderId);
    if (!order) return { error: "not_found" };
    if (!order.cancellable) return { error: "not_cancellable" };
    return `Cancel order ${order.id} (${order.status}). Press Confirm to cancel it.`;
  }
  const shown = action.message.trim().slice(0, 500);
  if (shown.length < 5) return { error: "invalid_body" };
  const lines = await rememberedLines(userId);
  if (!textAppearsIn(shown, lines)) return { error: "report_not_typed" };
  return `Send report: ${shown}`;
}

/**
 * Drops any caller-supplied recommendation id. An add keeps one only when this
 * shopper and chat session were shown that product, and the id is the server's.
 */
async function verifiedAdd(userId: string, action: ShopAction, sessionId: string | null): Promise<ShopAction> {
  if (action.op === "report_problem") {
    return { op: "report_problem", message: action.message.trim().slice(0, 500) };
  }
  if (action.op !== "add_to_cart") return action;
  const base: ShopAction =
    action.qty === undefined
      ? { op: "add_to_cart", productId: action.productId }
      : { op: "add_to_cart", productId: action.productId, qty: action.qty };
  if (!sessionId) return base;
  const known = await lookupShownRecommendation(userId, sessionId, action.productId);
  if (!known) return base;
  return { ...base, recommendationId: known };
}

function signedAction(action: ShopAction): ShopAction {
  if (action.op !== "add_to_cart" || action.recommendationId) return action;
  return action.qty === undefined
    ? { op: "add_to_cart", productId: action.productId }
    : { op: "add_to_cart", productId: action.productId, qty: action.qty };
}

/** Signs a pending action. Does not change the cart, orders, or feedback. */
export async function proposeAction(
  userId: string,
  action: ShopAction,
  opts?: { sessionId?: string | null; overCap?: boolean; activityId?: string; reason?: string },
): Promise<PendingAction | { error: string }> {
  if (!ActionBody.safeParse(action).success) return { error: "invalid_body" };
  // Only the server's own over-cap step may sign "anyway"; a caller cannot ask for it.
  if (action.op === "place_order" && action.anyway && !opts?.overCap) return { error: "invalid_body" };
  const summary = await summaryFor(userId, action);
  if (typeof summary !== "string") return summary;
  const sessionId = action.op === "add_to_cart" ? biSessionId(opts?.sessionId) : null;
  const stored = await verifiedAdd(userId, action, sessionId);
  const cart = action.op === "place_order" ? await getCart(userId) : null;
  const cartHash = cart ? cartFingerprint(cart) : undefined;
  const reason = opts?.reason?.trim().slice(0, 200) || undefined;
  const boundSession = stored.op === "add_to_cart" && stored.recommendationId && sessionId ? sessionId : undefined;
  const claims: SignedAction = {
    typ: "action",
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + ACTION_TTL_SEC,
    jti: randomBytes(16).toString("base64url"),
    summary,
    action: stored,
    ...(cartHash ? { cartHash } : {}),
    ...(boundSession ? { sessionId: boundSession } : {}),
    ...(opts?.activityId ? { activityId: opts.activityId } : {}),
    ...(reason ? { reason } : {}),
  };
  await issueNonce(claims.jti, ACTION_TTL_SEC);
  const token = signActionToken(claims, secret());
  await bestEffort(
    recordActivity(userId, {
      id: activityIdOf(claims),
      ts: new Date().toISOString(),
      agent: BARISTA,
      action: stored.op,
      subject: subjectOf(stored, cart),
      reason: reason ?? DEFAULT_REASON,
      amountCents: amountOf(stored, cart),
      orderId: null,
      status: "waiting",
    }),
  );
  return { pending: true, actionId: token, summary };
}

const DEFAULT_REASON = "You asked Barista in chat.";

function activityIdOf(claims: Pick<SignedAction, "jti" | "activityId">): string {
  return claims.activityId ?? newActivityId("act", claims.jti);
}

function nameList(names: string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
  return (more > 0 ? `${head} and ${more} more` : head).slice(0, 80);
}

function subjectOf(action: ShopAction, cart: CartSnapshot | null): string {
  const name = (id: string) => getProduct(id)?.name ?? "";
  if (action.op === "add_many") return nameList(action.lines.map((line) => name(line.productId)).filter(Boolean));
  if (action.op === "add_to_cart" || action.op === "update_cart_qty" || action.op === "remove_from_cart") return name(action.productId);
  if (action.op === "place_order" && cart) return nameList(cart.items.map((item) => name(item.productId)).filter(Boolean));
  return "";
}

function amountOf(action: ShopAction, cart: CartSnapshot | null): number | null {
  const price = (id: string) => getProduct(id)?.price ?? 0;
  if (action.op === "add_many") return action.lines.reduce((sum, line) => sum + price(line.productId) * line.qty, 0);
  if (action.op === "add_to_cart") return price(action.productId) * (action.qty ?? 1);
  if (action.op === "place_order" && cart) return cart.totalCents;
  return null;
}

function cartLine(prefix: string, cart: CartSnapshot): string {
  return `${prefix} Cart total ${money(cart.totalCents)}.`;
}

/** Checks the signature and the shopper, claims the nonce, then writes. A failed write puts the nonce back. */
export async function commitAction(userId: string, actionId: string, shopper: Shopper): Promise<CommitResult> {
  const claims = verifyAction(actionId, secret());
  if (!claims || claims.sub !== userId) return fail(403, "invalid_action", "That confirmation is not valid.");
  const lines = await rememberedLines(userId);
  if (claims.action.op === "apply_coupon" && !codeAppearsIn(claims.action.code, lines)) {
    return fail(400, "coupon_not_typed", "Type the coupon code in the chat, then ask again.");
  }
  if (claims.action.op === "report_problem") {
    if (!textAppearsIn(claims.action.message, lines)) {
      return fail(400, "report_not_typed", "The report must be text you typed in this chat.");
    }
    if (await tooManyFeedbackReports(userId)) {
      return fail(429, "rate_limited", "Too many reports. Try again in a little while.");
    }
  }
  if (claims.action.op === "place_order") {
    const cart = await getCart(userId);
    if (cartFingerprint(cart) !== claims.cartHash) {
      return fail(409, "cart_changed", "Your cart changed. Ask again to place the order.");
    }
    const { agentPrefs } = await getShopperFlags(userId);
    if (!agentPrefs.consentAt) {
      return fail(403, "consent_required", "Allow Barista to order for you first.");
    }
    if (!claims.action.anyway && cart.totalCents > agentPrefs.capCents) {
      if (!(await consumeNonce(claims.jti))) return fail(409, "already_used", "That confirmation was already used.");
      const cap = money(agentPrefs.capCents);
      const again = await proposeAction(
        userId,
        { op: "place_order", anyway: true },
        {
          overCap: true,
          activityId: activityIdOf(claims),
          reason: `${claims.reason ?? DEFAULT_REASON} Over your ${cap} cap per order, so Barista asked for a second OK.`,
        },
      );
      if (!("actionId" in again)) return fail(409, "over_cap", "This order is over your cap per order.");
      return {
        ok: true,
        summary: again.summary,
        overCap: { actionId: again.actionId, summary: again.summary, totalCents: cart.totalCents, capCents: agentPrefs.capCents },
      };
    }
  }
  if (!(await consumeNonce(claims.jti))) return fail(409, "already_used", "That confirmation was already used.");

  const outcome = await perform(userId, claims.action, shopper, claims.sessionId, claims.reason);
  if (!outcome.ok) {
    await rearmNonce(claims.jti, claims.exp - Math.floor(Date.now() / 1000));
    return outcome;
  }
  const change: ActivityChange = {
    status: "done",
    ...(outcome.order
      ? {
          orderId: outcome.order.id,
          amountCents: outcome.order.totalCents,
          subject: nameList(outcome.order.lines.map((line) => line.name)),
        }
      : {}),
  };
  return { ...outcome, audit: { id: activityIdOf(claims), change } };
}

function noteRecommendedAdd(userId: string, action: ShopAction, sessionId?: string): void {
  if (action.op !== "add_to_cart") return;
  const recommendationId = biId(action.recommendationId);
  const productId = biId(action.productId);
  if (!recommendationId || !productId) return;
  const qty = action.qty ?? 1;
  const session = biSessionId(sessionId);
  emitBi(() =>
    trackAdded(session ? { sub: userId, sessionId: session } : { sub: userId }, {
      recommendationId,
      productId,
      qty,
    }),
  );
}

async function perform(
  userId: string,
  action: ShopAction,
  shopper: Shopper,
  sessionId?: string,
  reason?: string,
): Promise<CommitResult> {
  if (action.op === "add_to_cart") {
    const result = await addToCart(userId, action.productId, action.qty ?? 1);
    if ("error" in result) return writeError(result);
    noteRecommendedAdd(userId, action, sessionId);
    return { ok: true, summary: cartLine("Cart updated.", result) };
  }
  if (action.op === "update_cart_qty") {
    const result = await setCartQty(userId, action.productId, action.qty);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: cartLine("Quantity updated.", result) };
  }
  if (action.op === "remove_from_cart") {
    const result = await removeFromCart(userId, action.productId, action.qty ?? 1);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: cartLine("Item removed.", result) };
  }
  if (action.op === "add_many") {
    const result = await addManyToCart(userId, action.lines);
    if ("error" in result) return writeError(result);
    // The cart is already written, so a failure signing the follow-up must not fail (and re-arm) this Confirm.
    const next = await proposeAction(userId, { op: "place_order" }, { reason }).catch(() => null);
    return {
      ok: true,
      summary: cartLine("Added to your cart.", result),
      ...(next && "actionId" in next ? { next: nextStep(next, result) } : {}),
    };
  }
  if (action.op === "apply_coupon") {
    const result = await applyCoupon(userId, action.code);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: cartLine("Coupon applied.", result) };
  }
  if (action.op === "place_order") {
    const result = await placeOrder(userId, new Date(), { placedBy: "barista" });
    if ("error" in result) return writeError(result);
    const detail = await getOrder(userId, result.id).catch(() => null);
    return {
      ok: true,
      summary: `Order ${result.id} placed. Total ${money(result.totalCents)}.`,
      order: {
        id: result.id,
        createdAt: result.createdAt,
        totalCents: result.totalCents,
        lines: (detail?.items ?? []).map((item) => ({ name: item.name, qty: item.qty, unitPriceCents: item.unitPriceCents })),
        undoUntil: undoDeadline(new Date(result.createdAt)).toISOString(),
      },
    };
  }
  if (action.op === "cancel_order") {
    const result = await cancelOrder(userId, action.orderId);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: `Order ${result.id} is cancelled.` };
  }
  return {
    ok: true,
    summary: "Your report was sent.",
    report: { feedback: action.message.trim(), reportedBy: reporterBlock(shopper) },
  };
}

function nextStep(pending: PendingAction, cart: CartSnapshot): NextStep {
  return {
    actionId: pending.actionId,
    summary: pending.summary,
    cart: {
      lines: cart.items.flatMap((item) => {
        const product = getProduct(item.productId);
        return product ? [{ productId: item.productId, name: product.name, qty: item.qty, unitPriceCents: product.price }] : [];
      }),
      totalCents: cart.totalCents,
    },
  };
}

function writeError(result: { error: string; message?: string }): CommitResult {
  if (result.error === "rate_limited") {
    return fail(429, "rate_limited", result.message ?? "Too many updates. Please try again in a little while.");
  }
  if (result.error === "not_found") return fail(404, "not_found", "That order was not found.");
  if (result.error === "not_cancellable") return fail(409, "not_cancellable", "This order can no longer be cancelled.");
  if (result.error === "empty_cart") return fail(400, "empty_cart", "Your cart is empty.");
  if (result.error === "invalid_coupon") return fail(400, "invalid_coupon", "That coupon code is not valid.");
  if (result.error === "unknown_product") return fail(400, "unknown_product", "That product is not in the catalogue.");
  if (result.error === "qty_limit") return fail(400, "qty_limit", "Quantity must be from 1 to 99.");
  return fail(400, result.error, "That change could not be made.");
}
