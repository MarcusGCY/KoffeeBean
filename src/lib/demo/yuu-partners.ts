import { isPelitaArtKey, type PelitaArtKey } from "./pelita-art";
import type { Scenario } from "./scenario";

export type PartnerOffer = {
  id: string;
  name: string;
  size: string;
  price: number;
  art: PelitaArtKey;
  /**
   * True once Pelita stocks the sku. The demand-gap product stays false until
   * approval 2 lists it. Partner purchases do not put it on the Pelita shelf.
   */
  atPelita: boolean;
  /** Real pack shot when a launch config names one. Absent means the kit SVG. */
  imageUrl?: string | null;
};

/** Coalition products a signed-in shopper can buy with yuu, including skus Pelita does not stock. */
export function partnerOffers(scenario: Scenario, listed: boolean): PartnerOffer[] {
  return scenario.storefront.yuuPartners.productIds.map((id) => {
    const item = scenario.catalogue.find((row) => row.id === id);
    if (!item) throw new Error(`yuu partner shelf lists ${id}, which is not in the catalogue`);
    if (!isPelitaArtKey(item.art)) throw new Error(`Unknown art key "${item.art}" for ${item.id}`);
    const atPelita = item.stock.status !== "unlisted" || (listed && item.launchedInDemo === true);
    return {
      id: item.id,
      name: item.name,
      size: item.size,
      price: item.salePrice ?? item.price,
      art: item.art,
      atPelita,
    };
  });
}
