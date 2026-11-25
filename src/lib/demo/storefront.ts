import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { CatalogueItem, Scenario } from "./scenario";

export type StockStatus = "in" | "low" | "out";

export type ProductCardData = {
  id: string;
  name: string;
  size: string;
  category: string;
  art: PelitaArtKey;
  /** The price a shopper pays today: the sale price when there is one. */
  price: number;
  wasPrice: number | null;
  ribbon: string | null;
  tag: "New" | "Bestseller" | null;
  memberPrice: number | null;
  stock: { status: StockStatus; label: string };
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
};

// Presentation choices for screen 00, not catalogue facts.
const HERO_ART: PelitaArtKey[] = ["vitc", "fishoil", "vitd"];
const SIDE_ART: PelitaArtKey = "sunscreen";

export function formatSgd(amount: number): string {
  return `S$${amount.toFixed(2)}`;
}

function stockOf(item: CatalogueItem): { status: StockStatus; label: string } | null {
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

function toCard(item: CatalogueItem): ProductCardData | null {
  const stock = stockOf(item);
  if (!stock) return null;
  if (!isPelitaArtKey(item.art)) throw new Error(`Unknown art key "${item.art}" for ${item.id}`);
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    category: item.category,
    art: item.art,
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

/** Turns the validated fixture into the plain data the storefront renders. */
export function storefrontView(scenario: Scenario): StorefrontView {
  const cards = new Map<string, ProductCardData>();
  for (const item of scenario.catalogue) {
    const card = toCard(item);
    if (card) cards.set(item.id, card);
  }
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
