import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { getProduct } from "./cart";
import { findCoupon } from "./coupons";
import { safeEqual } from "./github-signature";
import { tooManyFeedbackReports } from "./rate-limit";
import { reporterBlock, type Shopper } from "./shopper";
import { StoreUnavailableError } from "./store-error";
import {
  addToCart,
  applyCoupon,
  cancelOrder,
  getCart,
  getOrder,
  placeOrder,
  removeFromCart,
  setCartQty,
} from "./store-meta";
import type { CartSnapshot } from "./store-types";
import { consumeNonce, issueNonce, rearmNonce, rememberedLines } from "./upstash";

/** Confirm tokens last five minutes and can be used once. */
export const ACTION_TTL_SEC = 300;

const Qty = z.number().int().min(1).max(99);
const ProductId = z.string().trim().min(1).max(80);

export const ActionBody = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add_to_cart"), productId: ProductId, qty: Qty.optional() }),
  z.strictObject({ op: z.literal("update_cart_qty"), productId: ProductId, qty: Qty }),
  z.strictObject({ op: z.literal("remove_from_cart"), productId: ProductId, qty: Qty.optional() }),
  z.strictObject({ op: z.literal("apply_coupon"), code: z.string().trim().min(1).max(40) }),
  z.strictObject({ op: z.literal("place_order") }),
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
};

export type PendingAction = { pending: true; actionId: string; summary: string };

export type CommitResult =
  | { ok: true; summary: string; report?: { feedback: string; reportedBy: string } }
  | { ok: false; status: number; error: string; message: string };

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function secret(): string {
  const value = process.env.SUPPORT_AGENT_SECRET?.trim() ?? "";
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
    return {
      typ: "action",
      sub: claims.sub,
      exp: claims.exp,
      jti: claims.jti,
      summary: claims.summary,
      action: action.data,
      cartHash: claims.cartHash,
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

/** Signs a pending action. Does not change the cart, orders, or feedback. */
export async function proposeAction(userId: string, action: ShopAction): Promise<PendingAction | { error: string }> {
  const summary = await summaryFor(userId, action);
  if (typeof summary !== "string") return summary;
  const stored: ShopAction =
    action.op === "report_problem"
      ? { op: "report_problem", message: action.message.trim().slice(0, 500) }
      : action;
  const cartHash = action.op === "place_order" ? cartFingerprint(await getCart(userId)) : undefined;
  const claims: SignedAction = {
    typ: "action",
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + ACTION_TTL_SEC,
    jti: randomBytes(16).toString("base64url"),
    summary,
    action: stored,
    ...(cartHash ? { cartHash } : {}),
  };
  await issueNonce(claims.jti, ACTION_TTL_SEC);
  return { pending: true, actionId: signActionToken(claims, secret()), summary };
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
  }
  if (!(await consumeNonce(claims.jti))) return fail(409, "already_used", "That confirmation was already used.");

  const outcome = await perform(userId, claims.action, shopper);
  if (!outcome.ok) {
    await rearmNonce(claims.jti, claims.exp - Math.floor(Date.now() / 1000));
    return outcome;
  }
  return outcome;
}

async function perform(userId: string, action: ShopAction, shopper: Shopper): Promise<CommitResult> {
  if (action.op === "add_to_cart") {
    const result = await addToCart(userId, action.productId, action.qty ?? 1);
    if ("error" in result) return writeError(result);
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
  if (action.op === "apply_coupon") {
    const result = await applyCoupon(userId, action.code);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: cartLine("Coupon applied.", result) };
  }
  if (action.op === "place_order") {
    const result = await placeOrder(userId);
    if ("error" in result) return writeError(result);
    return { ok: true, summary: `Order ${result.id} placed. Total ${money(result.totalCents)}.` };
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

function writeError(result: { error: string; message?: string }): CommitResult {
  if (result.error === "rate_limited") {
    return fail(429, "rate_limited", result.message ?? "Too many updates. Please try again in a little while.");
  }
  if (result.error === "not_found") return fail(404, "not_found", "That order was not found.");
  if (result.error === "not_cancellable") return fail(409, "not_cancellable", "This order can no longer be cancelled.");
  if (result.error === "empty_cart") return fail(400, "empty_cart", "Your cart is empty.");
  if (result.error === "invalid_coupon") return fail(400, "invalid_coupon", "That coupon code is not valid.");
  if (result.error === "qty_limit") return fail(400, "qty_limit", "Quantity must be from 1 to 99.");
  return fail(400, result.error, "That change could not be made.");
}
