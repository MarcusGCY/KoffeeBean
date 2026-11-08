import products from "@/data/products.json";
import { loadFaq } from "@/lib/faq";
import { resolveCouponOffer, type CouponOfferView } from "@/lib/coupon-offer";
import { proposeAction } from "@/lib/pending-action";
import { getCart, getOrder, listOrders, readCommerceFacts, recordAudit } from "@/lib/store-meta";

export type Principal = { principalId?: string } | null | undefined;

type ToolInput = { userId?: unknown };

/** Shopper id from the session principal. A user id on the tool input is ignored. */
export function customerId(auth: Principal, input?: ToolInput | null): string {
  void input?.userId;
  const id = auth?.principalId?.trim() ?? "";
  if (!id) throw new Error("no_customer");
  return id;
}

async function note(userId: string, tool: string, summary: string, outcome: string): Promise<void> {
  await recordAudit(userId, { ts: new Date().toISOString(), tool, summary, outcome });
}

export async function faqAnswer(auth: Principal, input: ToolInput & { question?: unknown }) {
  void input.question;
  const userId = customerId(auth, input);
  try {
    const faq = loadFaq();
    await note(userId, "faq_answer", "Returned the approved FAQ", "ok");
    return { faq };
  } catch {
    return { error: "shop_unavailable" };
  }
}

export async function listProducts(auth: Principal, input: ToolInput) {
  const userId = customerId(auth, input);
  try {
    await note(userId, "list_products", `Returned ${products.length} products`, "ok");
    return { products };
  } catch {
    return { error: "shop_unavailable" };
  }
}

export async function viewCart(auth: Principal, input: ToolInput) {
  const userId = customerId(auth, input);
  try {
    const cart = await getCart(userId);
    await note(userId, "view_cart", `${cart.items.length} cart lines`, "ok");
    return {
      items: cart.items,
      subtotalCents: cart.subtotalCents,
      discountCents: cart.discountCents,
      taxCents: cart.taxCents,
      totalCents: cart.totalCents,
      discountApplied: cart.discountCents > 0,
    };
  } catch {
    return { error: "shop_unavailable" };
  }
}

function offerAudit(view: CouponOfferView): string {
  const cart = view.cartHasItems == null ? "unknown" : view.cartHasItems ? "yes" : "no";
  const returning = view.returningCustomer == null ? "unknown" : view.returningCustomer ? "yes" : "no";
  const completed = view.completedPurchases == null ? "unknown" : String(view.completedPurchases);
  return `cart=${cart} returning=${returning} completed=${completed} reason=${view.reason}`;
}

/** Reads this shopper's cart and completed purchases. Does not apply a coupon. */
export async function lookupCouponOffer(auth: Principal, input: ToolInput) {
  const userId = customerId(auth, input);
  try {
    const view = resolveCouponOffer(await readCommerceFacts(userId));
    await note(userId, "lookup_coupon_offer", offerAudit(view), view.reason);
    return view;
  } catch {
    return { error: "shop_unavailable" as const };
  }
}

export async function listMyOrders(auth: Principal, input: ToolInput) {
  const userId = customerId(auth, input);
  try {
    const orders = await listOrders(userId);
    await note(userId, "list_my_orders", `${orders.length} orders`, "ok");
    return {
      orders: orders.map((order) => ({
        id: order.id,
        createdAt: order.createdAt,
        status: order.status,
        cancellable: order.cancellable,
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
      })),
    };
  } catch {
    return { error: "shop_unavailable" };
  }
}

export async function getOrderStatus(auth: Principal, input: ToolInput & { orderId?: unknown }) {
  const userId = customerId(auth, input);
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  if (!orderId || orderId.length > 40 || orderId.includes("/")) return { error: "invalid_order" };
  try {
    const order = await getOrder(userId, orderId);
    await note(userId, "get_order_status", order ? `${order.id} ${order.status}` : "Order was not found", order ? "ok" : "not_found");
    if (!order) return { error: "not_found" };
    return {
      id: order.id,
      createdAt: order.createdAt,
      status: order.status,
      cancellable: order.cancellable,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      items: order.items,
    };
  } catch {
    return { error: "shop_unavailable" };
  }
}

export function proposeAddToCart(auth: Principal, input: ToolInput & { productId?: unknown; qty?: unknown }) {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 1;
  return proposeAction(customerId(auth, input), { op: "add_to_cart", productId, qty });
}

export function proposeUpdateQty(auth: Principal, input: ToolInput & { productId?: unknown; qty?: unknown }) {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 0;
  return proposeAction(customerId(auth, input), { op: "update_cart_qty", productId, qty });
}

export function proposeRemoveFromCart(auth: Principal, input: ToolInput & { productId?: unknown; qty?: unknown }) {
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const qty = typeof input.qty === "number" ? input.qty : 1;
  return proposeAction(customerId(auth, input), { op: "remove_from_cart", productId, qty });
}

export function proposeApplyCoupon(auth: Principal, input: ToolInput & { code?: unknown }) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  return proposeAction(customerId(auth, input), { op: "apply_coupon", code });
}

export function proposePlaceOrder(auth: Principal, input: ToolInput) {
  return proposeAction(customerId(auth, input), { op: "place_order" });
}

export function proposeCancelOrder(auth: Principal, input: ToolInput & { orderId?: unknown }) {
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  return proposeAction(customerId(auth, input), { op: "cancel_order", orderId });
}

export function proposeReportProblem(auth: Principal, input: ToolInput & { message?: unknown }) {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  return proposeAction(customerId(auth, input), { op: "report_problem", message });
}
