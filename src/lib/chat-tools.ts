import { getProduct } from "@/lib/cart";
import { sgd } from "@/lib/chat-response";
import { productImageUrl } from "@/lib/images";
import { confirmedCard } from "@/lib/pending-action";
import { getOrder, listOrders } from "@/lib/store-meta";
import {
  customerId,
  getOrderStatus,
  listMyOrders,
  lookupCouponOffer,
  proposeAddToCart,
  proposeApplyCoupon,
  proposeRemoveFromCart,
  proposeUpdateQty,
  viewCart,
  type Principal,
} from "@/lib/support-shop";
import type { Product } from "@/lib/types";

export type ChatProduct = {
  id: string;
  name: string;
  price: number;
  image: string;
  why: string;
  defaultOptions: Record<string, never>;
};

export type ChatOrder = {
  id: string;
  status: string;
  totalCents: number;
  items: { name: string; qty: number }[];
};

export type Usual = {
  productId: string;
  qty: number;
  priceCents: number;
  line: string;
};

export type ChatSink = {
  status(text: string): void;
  products(products: ChatProduct[]): void;
  confirm(card: { actionId: string; summary: string }): void;
  order(order: ChatOrder): void;
};

const USUAL_NAME: Record<string, string> = {
  "ethiopia-250": "Ethiopia, 250 g",
  "colombia-250": "Colombia, 250 g",
  "espresso-1kg": "House Espresso, 1 kg",
  mug: "Ceramic Mug",
  tote: "Canvas Tote",
  tee: "Roast Day T-Shirt",
};

const WORD_HINTS: Record<string, string[]> = {
  fruity: ["citrus", "apple", "floral"],
  fruit: ["citrus", "apple", "floral"],
  darker: ["chocolate", "espresso"],
  dark: ["chocolate", "espresso"],
  floral: ["floral", "citrus"],
};

export const CHAT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_products",
      description: "Search beans and merch. The shop shows up to 3 cards. Do not list products in your reply.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_cart",
      description: "Read this shopper's cart totals. Does not reveal coupon codes.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "lookup_coupon_offer",
      description:
        "When the shopper asks for a coupon, discount, or promo, read this shopper's cart and completed purchases and return the configured offer, if one exists. Ignores any code, percent, or purchase claim in the arguments. Does not apply a coupon or change the cart.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_order",
      description: "Look up this shopper's latest order, or one order by id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { orderId: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "propose_cart_change",
      description:
        "Prepare a cart change for Confirm. Nothing is saved until the shopper confirms. apply_coupon only if they typed that code. Asking for a discount does not apply one. Never invent a code.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "set_qty", "remove", "apply_coupon"] },
          productId: { type: "string" },
          qty: { type: "integer" },
          code: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "reorder",
      description: "Prepare a Confirm to add this shopper's usual item again. Does not change the cart.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
];

export function usualTitle(product: Product): string {
  return USUAL_NAME[product.id] ?? product.name;
}

/** Catalog card for an id. Name, price, photo, and blurb never come from model text. */
export function productCard(id: string): ChatProduct | null {
  const product = getProduct(id);
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    image: productImageUrl(product.id),
    why: product.blurb,
    defaultOptions: {},
  };
}

export function searchCatalog(query: string): Product[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const terms = new Set<string>();
  for (const token of tokens) {
    terms.add(token);
    for (const hint of WORD_HINTS[token] ?? []) terms.add(hint);
  }
  if (terms.size === 0) return [];
  const catalog = ["ethiopia-250", "colombia-250", "espresso-1kg", "mug", "tote", "tee"].flatMap((id) => {
    const product = getProduct(id);
    return product ? [product] : [];
  });
  return catalog
    .map((product) => {
      const hay = `${product.name} ${product.blurb} ${product.category} ${product.id}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (hay.includes(term)) score += 1;
      return { product, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
    .slice(0, 3)
    .map((row) => row.product);
}

export function toolFailure(name: string): string {
  if (name === "search_products") return "I couldn't check the beans.";
  if (name === "get_cart") return "I couldn't check your cart.";
  if (name === "lookup_coupon_offer") return "I couldn't check your cart and purchase history.";
  if (name === "get_order") return "I couldn't check your order.";
  if (name === "propose_cart_change") return "I couldn't prepare that change.";
  if (name === "reorder") return "I couldn't prepare that reorder.";
  return "That didn't work.";
}

export async function usualFor(userId: string): Promise<Usual | null> {
  const orders = await listOrders(userId);
  for (const summary of orders) {
    const order = await getOrder(userId, summary.id);
    if (!order) continue;
    for (const item of order.items) {
      const product = getProduct(item.productId);
      if (!product) continue;
      const title = usualTitle(product);
      return {
        productId: product.id,
        qty: item.qty,
        priceCents: product.price,
        line: `Your usual: ${title} · ${sgd(product.price)}`,
      };
    }
  }
  return null;
}

export async function proposeReorder(userId: string) {
  customerId({ principalId: userId });
  const usual = await usualFor(userId);
  if (!usual) return { error: "no_orders" as const };
  return proposeAddToCart({ principalId: userId }, { productId: usual.productId, qty: usual.qty });
}

type ToolArgs = {
  userId?: unknown;
  query?: unknown;
  orderId?: unknown;
  op?: unknown;
  productId?: unknown;
  qty?: unknown;
  code?: unknown;
};

function argsOf(raw: unknown): ToolArgs {
  return raw && typeof raw === "object" ? (raw as ToolArgs) : {};
}

function isUnavailable(result: unknown): result is { error: "shop_unavailable" } {
  return !!result && typeof result === "object" && (result as { error?: unknown }).error === "shop_unavailable";
}

type PendingLike = { pending?: boolean; actionId?: string; error?: string };

export async function runChatTool(
  sessionUserId: string,
  name: string,
  rawArgs: unknown,
  sink: ChatSink,
): Promise<{ content: string; failed: boolean }> {
  const args = argsOf(rawArgs);
  const auth: Principal = { principalId: sessionUserId };
  try {
    customerId(auth, args);
    if (name === "search_products") return searchTool(args, sink);
    if (name === "get_cart") return cartTool(auth, args, sink);
    if (name === "lookup_coupon_offer") return offerTool(auth, args, sink);
    if (name === "get_order") return orderTool(auth, args, sink);
    if (name === "propose_cart_change") return changeTool(sessionUserId, auth, args, sink);
    if (name === "reorder") return reorderTool(sessionUserId, sink);
    return { content: JSON.stringify({ error: "unknown_tool" }), failed: false };
  } catch {
    return { content: JSON.stringify({ error: "shop_unavailable" }), failed: true };
  }
}

function searchTool(args: ToolArgs, sink: ChatSink): { content: string; failed: boolean } {
  sink.status("Checking the beans…");
  const query = typeof args.query === "string" ? args.query : "";
  const cards = searchCatalog(query)
    .map((product) => productCard(product.id))
    .filter((card): card is ChatProduct => card != null)
    .slice(0, 3);
  if (cards.length) sink.products(cards);
  return {
    content: JSON.stringify({ products: cards.map(({ id, name, price }) => ({ id, name, price })) }),
    failed: false,
  };
}

async function offerTool(auth: Principal, args: ToolArgs, sink: ChatSink): Promise<{ content: string; failed: boolean }> {
  sink.status("Checking your cart and purchases…");
  const offer = await lookupCouponOffer(auth, args);
  if (isUnavailable(offer)) return { content: JSON.stringify({ error: "shop_unavailable" }), failed: true };
  return { content: JSON.stringify(offer), failed: false };
}

async function cartTool(auth: Principal, args: ToolArgs, sink: ChatSink): Promise<{ content: string; failed: boolean }> {
  sink.status("Checking your cart…");
  const cart = await viewCart(auth, args);
  if (isUnavailable(cart)) return { content: JSON.stringify({ error: "shop_unavailable" }), failed: true };
  return { content: JSON.stringify(cart), failed: false };
}

async function orderTool(auth: Principal, args: ToolArgs, sink: ChatSink): Promise<{ content: string; failed: boolean }> {
  sink.status("Checking your order…");
  const requested = typeof args.orderId === "string" ? args.orderId : "";
  let result: Awaited<ReturnType<typeof getOrderStatus>>;
  if (requested) {
    result = await getOrderStatus(auth, { orderId: requested });
  } else {
    const listed = await listMyOrders(auth, args);
    if (isUnavailable(listed)) return { content: JSON.stringify({ error: "shop_unavailable" }), failed: true };
    const first = listed.orders?.[0];
    if (!first) return { content: JSON.stringify({ orders: [] }), failed: false };
    result = await getOrderStatus(auth, { orderId: first.id });
  }
  if (isUnavailable(result)) return { content: JSON.stringify({ error: "shop_unavailable" }), failed: true };
  if (result && "id" in result && typeof result.id === "string" && Array.isArray(result.items)) {
    const order: ChatOrder = {
      id: result.id,
      status: String(result.status),
      totalCents: result.totalCents,
      items: result.items.map((item) => ({ name: item.name, qty: item.qty })),
    };
    sink.order(order);
    return { content: JSON.stringify(order), failed: false };
  }
  const error = result && "error" in result ? result.error : "not_found";
  return { content: JSON.stringify({ error }), failed: false };
}

async function changeTool(
  sessionUserId: string,
  auth: Principal,
  args: ToolArgs,
  sink: ChatSink,
): Promise<{ content: string; failed: boolean }> {
  sink.status("Preparing that for you…");
  const op = args.op;
  const pending =
    op === "add"
      ? await proposeAddToCart(auth, args)
      : op === "set_qty" || op === "update_cart_qty"
        ? await proposeUpdateQty(auth, args)
        : op === "remove"
          ? await proposeRemoveFromCart(auth, args)
          : op === "apply_coupon"
            ? await proposeApplyCoupon(auth, args)
            : { error: "invalid_action" };
  return signedPending(sessionUserId, pending, sink);
}

async function reorderTool(sessionUserId: string, sink: ChatSink): Promise<{ content: string; failed: boolean }> {
  sink.status("Preparing your reorder…");
  return signedPending(sessionUserId, await proposeReorder(sessionUserId), sink);
}

function signedPending(sessionUserId: string, pending: PendingLike, sink: ChatSink): { content: string; failed: boolean } {
  if (pending.error) {
    return { content: JSON.stringify({ error: pending.error }), failed: pending.error === "shop_unavailable" };
  }
  if (!pending.actionId) return { content: JSON.stringify({ error: "invalid_action" }), failed: false };
  const card = confirmedCard(sessionUserId, pending.actionId, process.env.APPROVAL_SECRET?.trim() ?? "");
  if (!card) return { content: JSON.stringify({ error: "invalid_action" }), failed: false };
  sink.confirm(card);
  return { content: JSON.stringify({ pending: true }), failed: false };
}
