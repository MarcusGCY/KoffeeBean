import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { CatalogueItem, Scenario } from "./scenario";
import { searchCatalogue, type ProductCardData, type PublishedStorefront, type StorefrontView } from "./storefront";
import type { PartnerOffer } from "./yuu-partners";
import { YUU_STORES } from "../yuu/stores";
import {
  formatSgdCents,
  isLaunchLive,
  launchPreviewBanner,
  presentPromo,
  targetedLabel,
  type LaunchConfig,
  type MemberOffer,
} from "./launch";
import { isApprovedPl20055, packagePriceNote } from "./pl-20055-package";

const DEFAULT_ART: PelitaArtKey = "vitc";
const DEFAULT_STORE_IDS = ["harbour-mart", "ridge-pharmacy", "eastlink-grocery"] as const;

export type MemberOfferView = {
  headline: string;
  memberPriceLabel: string | null;
  bonusPoints: number | null;
  segmentLabel: string | null;
};

export type ProductDetailModel = {
  sku: string;
  title: string;
  subtitle: string | null;
  longCopy: string | null;
  bullets: string[];
  size: string | null;
  category: string | null;
  supplier: string | null;
  art: PelitaArtKey;
  imageUrl: string | null;
  shelfPriceLabel: string;
  payPriceLabel: string;
  wasPriceLabel: string | null;
  payPrice: number;
  promo: { type: string; label: string } | null;
  memberOffer: MemberOfferView | null;
  stores: string[];
  stock: { status: "in" | "low" | "out"; label: string };
  previewBanner: string | null;
  /** GST and promo-window detail for an approved package. Null for other products. */
  priceNote: string | null;
};

export type ResolvedProduct =
  | { hidden: true }
  | { hidden: false; product: ProductDetailModel };

export function defaultShelfStores(): string[] {
  return DEFAULT_STORE_IDS.flatMap((id) => {
    const name = YUU_STORES.find((store) => store.id === id)?.name;
    return name ? [name] : [];
  });
}

function artFor(scenario: Scenario, sku: string): PelitaArtKey {
  const item = scenario.catalogue.find((row) => row.id === sku);
  return item && isPelitaArtKey(item.art) ? item.art : DEFAULT_ART;
}

function memberView(offer: MemberOffer | undefined, extraCents: number | null): MemberOfferView | null {
  const cents = offer?.memberPriceCents ?? extraCents;
  const bonus = offer?.bonusPoints ?? null;
  const segment = offer?.segmentLabel?.trim() || null;
  const headline = offer?.headline?.trim() || null;
  if (cents == null && bonus == null && !segment && !headline) return null;
  return {
    headline: headline || "yuu member offer",
    memberPriceLabel: cents != null ? formatSgdCents(cents) : null,
    bonusPoints: bonus,
    segmentLabel: segment ? targetedLabel(segment) : null,
  };
}

function shelfStock(item: CatalogueItem, listed: boolean): ProductDetailModel["stock"] | null {
  if (item.stock.status === "unlisted") {
    return listed && item.launchedInDemo === true ? { status: "in", label: "In stock" } : null;
  }
  if (item.stock.status === "in") return { status: "in", label: "In stock" };
  if (item.stock.status === "low") {
    return { status: "low", label: item.stock.qty == null ? "Low stock" : `Low stock · ${item.stock.qty} left` };
  }
  return { status: "out", label: "Out of stock" };
}

function detailFromCatalogue(scenario: Scenario, item: CatalogueItem, stock: ProductDetailModel["stock"]): ProductDetailModel {
  const shelfCents = Math.round(item.price * 100);
  const payCents = item.salePrice == null ? shelfCents : Math.round(item.salePrice * 100);
  const memberCents = item.memberPrice == null ? null : Math.round(item.memberPrice * 100);
  const listing = item.id === scenario.listing.productId;
  return {
    sku: item.id,
    title: item.name,
    subtitle: item.unitPrice,
    longCopy: listing ? scenario.listing.description : `${item.name}. ${item.size}. Supplied by ${item.supplier}.`,
    bullets: listing ? [...scenario.claimsCheck.kept] : [],
    size: item.size,
    category: item.category,
    supplier: item.supplier,
    art: isPelitaArtKey(item.art) ? item.art : DEFAULT_ART,
    imageUrl: null,
    shelfPriceLabel: formatSgdCents(shelfCents),
    payPriceLabel: formatSgdCents(payCents),
    wasPriceLabel: payCents === shelfCents ? null : formatSgdCents(shelfCents),
    payPrice: payCents / 100,
    promo: item.promo ? { type: item.promo.kind, label: item.promo.ribbon } : null,
    memberOffer: memberView(undefined, memberCents),
    stores: defaultShelfStores(),
    stock,
    previewBanner: null,
    priceNote: null,
  };
}

/** A forced live launch, or a preview, can show a promo whose start is still ahead and whose end has not passed. */
function commercialNow(config: LaunchConfig, now: number, preview: boolean): number {
  const promo = config.promo;
  if (!promo?.startsAt) return now;
  const start = Date.parse(promo.startsAt);
  if (Number.isNaN(start) || now >= start) return now;
  if (promo.endsAt) {
    const end = Date.parse(promo.endsAt);
    if (!Number.isNaN(end) && now > end) return now;
  }
  return config.status === "live" || preview ? start : now;
}

function detailFromLaunch(scenario: Scenario, config: LaunchConfig, now: number, previewBanner: string | null): ProductDetailModel {
  const item = scenario.catalogue.find((row) => row.id === config.sku);
  const shown = presentPromo(config.promo, config.shelfPriceCents, commercialNow(config, now, previewBanner !== null));
  const payCents = shown?.payCents ?? config.shelfPriceCents;
  const listing = item?.id === scenario.listing.productId;
  return {
    sku: config.sku,
    title: config.title,
    subtitle: config.subtitle ?? item?.unitPrice ?? null,
    longCopy: config.longCopy ?? (listing ? scenario.listing.description : null),
    bullets: config.bullets ?? (listing ? [...scenario.claimsCheck.kept] : []),
    size: config.size ?? item?.size ?? null,
    category: config.category ?? item?.category ?? null,
    supplier: config.supplier ?? item?.supplier ?? null,
    art: artFor(scenario, config.sku),
    imageUrl: config.imageUrl ?? null,
    shelfPriceLabel: formatSgdCents(config.shelfPriceCents),
    payPriceLabel: formatSgdCents(payCents),
    wasPriceLabel: shown?.wasCents != null ? formatSgdCents(shown.wasCents) : null,
    payPrice: payCents / 100,
    promo: shown ? { type: shown.type, label: shown.label } : null,
    memberOffer: memberView(config.memberOffer, shown?.memberPriceCents ?? null),
    stores: config.stores ?? defaultShelfStores(),
    stock: { status: "in", label: "In stock" },
    previewBanner,
    priceNote: packagePriceNote(config),
  };
}

/** A launch config, when present, decides visibility. Otherwise the catalogue shelf rule applies. */
export function resolveProductPage(args: {
  sku: string;
  scenario: Scenario;
  listed: boolean;
  config: LaunchConfig | null;
  preview: boolean;
  now?: number;
}): ResolvedProduct {
  const now = args.now ?? Date.now();
  const config = args.config;
  if (config) {
    const live = isLaunchLive(config, now);
    const item = args.scenario.catalogue.find((row) => row.id === config.sku);
    const onShelf = item ? shelfStock(item, args.listed) !== null : false;
    const publishedPackage = onShelf && isApprovedPl20055(config);
    if (!live && !publishedPackage && !args.preview) return { hidden: true };
    const banner = live || publishedPackage ? null : launchPreviewBanner(config, now);
    return { hidden: false, product: detailFromLaunch(args.scenario, config, now, banner) };
  }
  const item = args.scenario.catalogue.find((row) => row.id === args.sku);
  const stock = item ? shelfStock(item, args.listed) : null;
  if (!item || !stock) return { hidden: true };
  return { hidden: false, product: detailFromCatalogue(args.scenario, item, stock) };
}

function cardFromLaunch(scenario: Scenario, config: LaunchConfig, now: number): ProductCardData {
  const item = scenario.catalogue.find((row) => row.id === config.sku);
  const shown = presentPromo(config.promo, config.shelfPriceCents, commercialNow(config, now, false));
  const payCents = shown?.payCents ?? config.shelfPriceCents;
  const memberCents = config.memberOffer?.memberPriceCents ?? shown?.memberPriceCents ?? null;
  return {
    id: config.sku,
    name: config.title,
    size: config.size ?? item?.size ?? "",
    category: config.category ?? item?.category ?? "",
    subcategory: item?.subcategory ?? null,
    art: artFor(scenario, config.sku),
    highlight: true,
    price: payCents / 100,
    wasPrice: shown?.wasCents != null ? shown.wasCents / 100 : null,
    ribbon: shown?.label ?? null,
    tag: item?.tags.includes("New") ? "New" : null,
    memberPrice: memberCents == null ? null : memberCents / 100,
    stock: { status: "in", label: "In stock" },
    imageUrl: config.imageUrl ?? null,
  };
}

function refreshPublished(published: PublishedStorefront, catalogue: ProductCardData[]): PublishedStorefront {
  const ids = new Set(catalogue.map((card) => card.id));
  const found = searchCatalogue(catalogue, published.proof.query);
  return {
    ...published,
    productIds: published.productIds.filter((id) => ids.has(id)),
    chips: published.chips.map((chip, index) => {
      const count = catalogue.filter((card) => card.subcategory === chip.label).length;
      return { ...chip, count: count > 0 ? count : null, kind: index === 0 ? "all" : count > 0 ? "group" : "static" };
    }),
    proof: { ...published.proof, after: found.length, afterLabel: found[0]?.stock.label ?? null },
  };
}

/**
 * Live launch configs join the shelf. Drafts and schedules that have not started
 * leave the shelf, including products the catalogue would otherwise show.
 * No configs leaves the view untouched.
 */
export function applyLaunchConfigs(view: StorefrontView, scenario: Scenario, configs: LaunchConfig[], now = Date.now()): StorefrontView {
  if (configs.length === 0) return view;
  const onShelf = new Set(view.catalogue.map((card) => card.id));
  // A schedule that has not started leaves the shelf. The approved PL-20055 package stays once the demo listing has published it.
  const publishedPackage = (config: LaunchConfig) => onShelf.has(config.sku) && isApprovedPl20055(config);
  const hidden = new Set(configs.filter((config) => !isLaunchLive(config, now) && !publishedPackage(config)).map((config) => config.sku));
  const live = configs.filter((config) => isLaunchLive(config, now) || publishedPackage(config));
  let catalogue = view.catalogue.filter((card) => !hidden.has(card.id));
  let deals = view.deals.products.filter((card) => !hidden.has(card.id));
  const extras: ProductCardData[] = [];
  for (const config of live) {
    const next = cardFromLaunch(scenario, config, now);
    const current = catalogue.find((card) => card.id === next.id);
    if (current) {
      const merged: ProductCardData = {
        ...current,
        name: next.name,
        size: next.size || current.size,
        category: next.category || current.category,
        art: next.art,
        price: next.price,
        wasPrice: next.wasPrice,
        ribbon: next.ribbon ?? current.ribbon,
        memberPrice: next.memberPrice,
        imageUrl: next.imageUrl ?? current.imageUrl,
      };
      catalogue = catalogue.map((card) => (card.id === next.id ? merged : card));
      deals = deals.map((card) => (card.id === next.id ? { ...merged, highlight: card.highlight } : card));
    } else {
      extras.push(next);
    }
  }
  extras.sort((a, b) => a.id.localeCompare(b.id));
  if (extras.length > 0) {
    catalogue = [...extras, ...catalogue];
    deals = [...extras, ...deals];
  }
  return {
    ...view,
    catalogue,
    deals: { ...view.deals, products: deals },
    published: view.published ? refreshPublished(view.published, catalogue) : null,
  };
}

/**
 * A configured sku is "At Pelita" on the yuu shelf only while its launch is live.
 * Live skus that are not already partner products are added.
 */
export function applyLaunchesToPartners(offers: PartnerOffer[], scenario: Scenario, configs: LaunchConfig[], now = Date.now()): PartnerOffer[] {
  const bySku = new Map(configs.map((config) => [config.sku, config]));
  const next = offers.map((offer) => {
    const config = bySku.get(offer.id);
    if (!config) return offer;
    const live = isLaunchLive(config, now);
    if (!live) return { ...offer, imageUrl: config.imageUrl ?? offer.imageUrl ?? null };
    const shown = presentPromo(config.promo, config.shelfPriceCents, commercialNow(config, now, false));
    return {
      ...offer,
      name: config.title,
      size: config.size ?? offer.size,
      price: (shown?.payCents ?? config.shelfPriceCents) / 100,
      atPelita: true,
      imageUrl: config.imageUrl ?? offer.imageUrl ?? null,
    };
  });
  const known = new Set(next.map((offer) => offer.id));
  for (const config of configs) {
    if (!isLaunchLive(config, now) || known.has(config.sku)) continue;
    const shown = presentPromo(config.promo, config.shelfPriceCents, commercialNow(config, now, false));
    next.push({
      id: config.sku,
      name: config.title,
      size: config.size ?? "",
      price: (shown?.payCents ?? config.shelfPriceCents) / 100,
      art: artFor(scenario, config.sku),
      atPelita: true,
      imageUrl: config.imageUrl ?? null,
    });
  }
  return next;
}
