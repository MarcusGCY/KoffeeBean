import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { PublishedView } from "./published-view";
import type { CatalogueItem, Scenario } from "./scenario";

export type StockStatus = "in" | "low" | "out";

export type ProductCardData = {
  id: string;
  name: string;
  size: string;
  category: string;
  subcategory: string | null;
  art: PelitaArtKey;
  /** The product launched in this demo gets the rose highlight once it is live. */
  highlight: boolean;
  /** The price a shopper pays today: the sale price when there is one. */
  price: number;
  wasPrice: number | null;
  ribbon: string | null;
  tag: "New" | "Bestseller" | null;
  memberPrice: number | null;
  stock: { status: StockStatus; label: string };
};

export type PublishedChip = {
  label: string;
  /** Listed products in this group, or null when the group is not tracked in the catalogue. */
  count: number | null;
  /** The first chip shows the whole row. Others filter only when the catalogue has products for them. */
  kind: "all" | "group" | "static";
};

/** Screen 06: what the storefront adds once approval 2 has listed the new product. */
export type PublishedStorefront = {
  category: string;
  breadcrumb: string[];
  chips: PublishedChip[];
  /** The launched row, new product first. */
  productIds: string[];
  toast: Pick<PublishedView, "title" | "line1" | "line2" | "liveIn" | "liveInDetail"> | null;
  proof: { query: string; before: number; after: number; afterLabel: string | null };
};

export type StorefrontView = {
  brand: { name: string; wordmark: string; wordmarkSub: string; currency: string };
  demoTag: string;
  utilityBar: { left: string[]; right: string[] };
  searchPlaceholder: string;
  categories: string[];
  hero: { kicker: string; headline: string; cta: string; art: PelitaArtKey[] };
  sideBanner: { kicker: string; headline: string; cta: string; art: PelitaArtKey };
  deals: { countdown: { prefix: string; parts: string[] }; products: ProductCardData[] };
  /** Everything a shopper can buy now. Unlisted products never appear. */
  catalogue: ProductCardData[];
  /** Null until the launched product is listed. */
  published: PublishedStorefront | null;
};

export type StorefrontOptions = {
  /** The launched product has been listed (approval 2). */
  listed?: boolean;
  published?: PublishedView | null;
};

// Presentation choices for screen 00, not catalogue facts.
const HERO_ART: PelitaArtKey[] = ["vitc", "fishoil", "vitd"];
const SIDE_ART: PelitaArtKey = "sunscreen";

export function formatSgd(amount: number): string {
  return `S$${amount.toFixed(2)}`;
}

function stockOf(item: CatalogueItem, listed: boolean): { status: StockStatus; label: string } | null {
  if (item.stock.status === "unlisted" && listed && item.launchedInDemo) return { status: "in", label: "In stock" };
  switch (item.stock.status) {
    case "in":
      return { status: "in", label: "In stock" };
    case "low":
      return { status: "low", label: item.stock.qty === null ? "Low stock" : `Low stock · ${item.stock.qty} left` };
    case "out":
      return { status: "out", label: "Out of stock" };
    case "unlisted":
      return null;
  }
}

function toCard(item: CatalogueItem, listed: boolean): ProductCardData | null {
  const stock = stockOf(item, listed);
  if (!stock) return null;
  if (!isPelitaArtKey(item.art)) throw new Error(`Unknown art key "${item.art}" for ${item.id}`);
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    category: item.category,
    subcategory: item.subcategory ?? null,
    art: item.art,
    highlight: listed && item.launchedInDemo === true,
    price: item.salePrice ?? item.price,
    wasPrice: item.salePrice === undefined ? null : item.price,
    ribbon: item.promo?.ribbon ?? null,
    tag: item.tags.includes("New") ? "New" : item.tags.includes("Bestseller") ? "Bestseller" : null,
    memberPrice: item.memberPrice,
    stock,
  };
}

/** "Ends in 2d 06h 14m" becomes the prefix "Ends in" and the parts ["2d", "06h", "14m"]. */
export function splitCountdown(label: string): { prefix: string; parts: string[] } {
  const match = /^(.*?)\s*((?:\d+[dhms]\s*)+)$/.exec(label.trim());
  if (!match) return { prefix: label, parts: [] };
  return { prefix: match[1], parts: match[2].trim().split(/\s+/) };
}

function cardsOf(scenario: Scenario, listed: boolean): Map<string, ProductCardData> {
  const cards = new Map<string, ProductCardData>();
  for (const item of scenario.catalogue) {
    const card = toCard(item, listed);
    if (card) cards.set(item.id, card);
  }
  return cards;
}

function publishedStorefront(scenario: Scenario, cards: Map<string, ProductCardData>, published: PublishedView | null): PublishedStorefront {
  const { publishedRow } = scenario.storefront;
  const { query } = scenario.published.searchProof;
  const live = [...cards.values()];
  const before = searchCatalogue([...cardsOf(scenario, false).values()], query).length;
  const found = searchCatalogue(live, query);
  return {
    category: publishedRow.category,
    breadcrumb: ["Home", publishedRow.category],
    chips: publishedRow.chips.map((label, i) => {
      const count = live.filter((p) => p.subcategory === label).length;
      return { label, count: count > 0 ? count : null, kind: i === 0 ? "all" : count > 0 ? "group" : "static" };
    }),
    productIds: publishedRow.productIds.filter((id) => cards.has(id)),
    toast: published
      ? { title: published.title, line1: published.line1, line2: published.line2, liveIn: published.liveIn, liveInDetail: published.liveInDetail }
      : null,
    proof: { query, before, after: found.length, afterLabel: found[0]?.stock.label ?? null },
  };
}

/** Turns the validated fixture into the plain data the storefront renders. */
export function storefrontView(scenario: Scenario, options: StorefrontOptions = {}): StorefrontView {
  const listed = options.listed === true;
  const cards = cardsOf(scenario, listed);
  const { storefront, brand } = scenario;
  const deals = storefront.dealsOfTheWeek.productIds.map((id) => {
    const card = cards.get(id);
    if (!card) throw new Error(`Deals of the week lists ${id}, which is not on sale`);
    return card;
  });
  return {
    brand: { name: brand.name, wordmark: brand.wordmark, wordmarkSub: brand.wordmarkSub, currency: brand.currency },
    demoTag: scenario.demoTag,
    utilityBar: storefront.utilityBar,
    searchPlaceholder: storefront.searchPlaceholder,
    categories: storefront.categories,
    hero: { ...storefront.hero, art: HERO_ART },
    sideBanner: { ...storefront.sideBanner, art: SIDE_ART },
    deals: { countdown: splitCountdown(storefront.dealsOfTheWeek.countdown), products: deals },
    catalogue: [...cards.values()],
    published: listed ? publishedStorefront(scenario, cards, options.published ?? null) : null,
  };
}

/** Case-insensitive match: every word of the query must appear in the product's name, size or category. */
export function searchCatalogue(products: ProductCardData[], query: string): ProductCardData[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return products;
  return products.filter((p) => {
    const haystack = `${p.name} ${p.size} ${p.category}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
