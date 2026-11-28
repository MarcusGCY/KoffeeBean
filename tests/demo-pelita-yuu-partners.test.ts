import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PelitaPartnerPurchases } from "@/components/pelita/PelitaPartnerPurchases";
import { YuuBuyFeedback } from "@/components/pelita/YuuBuyFeedback";
import { loadScenario } from "@/lib/demo/scenario";
import { storefrontView } from "@/lib/demo/storefront";
import { partnerOffers } from "@/lib/demo/yuu-partners";
import { isPelitaArtKey } from "@/lib/demo/pelita-art";
import { PELITA_SIGN_OUT_HREF, PELITA_YUU_PATH, PELITA_YUU_SIGN_IN_HREF } from "@/lib/return-to";
import { YUU_STORES } from "@/lib/yuu/stores";
import { yuuBoughtLine, YUU_BUY_LABEL, YUU_PARTNER_HEADING, YUU_SIGN_IN_LABEL } from "@/lib/yuu/types";

const scenario = loadScenario();

function partnerCard(markup: string, id: string): string {
  const marker = `data-yuu-partner="${id}"`;
  const start = markup.indexOf(marker);
  const next = markup.indexOf("data-yuu-partner=", start + marker.length);
  return markup.slice(start, next === -1 ? undefined : next);
}

function html(account: { name: string } | null, listed = false): string {
  return renderToStaticMarkup(
    createElement(PelitaPartnerPurchases, {
      offers: partnerOffers(scenario, listed),
      account,
      signInHref: PELITA_YUU_SIGN_IN_HREF,
      wordmark: scenario.brand.wordmark,
    }),
  );
}

describe("yuu partner purchases", () => {
  const gap = scenario.proposal.productId;

  it("offers the unlisted demand-gap sku without putting it on the Pelita shelf", () => {
    const offers = partnerOffers(scenario, false);
    expect(offers.map((offer) => offer.id)).toEqual(scenario.storefront.yuuPartners.productIds);
    expect(offers.find((offer) => offer.id === gap)).toMatchObject({ price: 32.9, atPelita: false });
    const partnerOnly = scenario.catalogue.filter(
      (item) =>
        scenario.storefront.yuuPartners.productIds.includes(item.id) &&
        item.stock.status === "unlisted" &&
        item.launchedInDemo !== true,
    );
    expect(partnerOnly.map((item) => item.id)).toEqual(["PL-20068", "PL-20071", "PL-20084", "PL-80041", "PL-80053"]);
    expect(offers.filter((offer) => offer.id !== gap && !partnerOnly.some((item) => item.id === offer.id)).every((offer) => offer.atPelita)).toBe(true);
    expect(offers.filter((offer) => partnerOnly.some((item) => item.id === offer.id)).every((offer) => offer.atPelita)).toBe(false);
    expect(storefrontView(scenario).catalogue.map((product) => product.id)).not.toContain(gap);

    const listed = partnerOffers(scenario, true);
    expect(listed.find((offer) => offer.id === gap)?.atPelita).toBe(true);
    expect(storefrontView(scenario, { listed: true }).catalogue.map((product) => product.id)).toContain(gap);
    const pelitaShelf = storefrontView(scenario, { listed: true }).catalogue.map((product) => product.id);
    for (const item of partnerOnly) {
      expect(listed.find((offer) => offer.id === item.id)).toMatchObject({ atPelita: false, art: item.art });
      expect(isPelitaArtKey(item.art)).toBe(true);
      expect(pelitaShelf).not.toContain(item.id);
      expect(item.promo).toBeNull();
    }
  });

  it("shows Buy with yuu on each partner product, and sign-in when nobody is signed in", () => {
    const signedOut = html(null);
    expect(signedOut).toContain(YUU_PARTNER_HEADING);
    expect(signedOut).toContain("Magnesium Glycinate 400 mg");
    expect(signedOut).toContain("S$32.90");
    expect(signedOut).toContain(`data-yuu-partner="${gap}"`);
    expect(signedOut).toContain(`data-yuu-buy="${gap}"`);
    expect(signedOut).toContain(YUU_SIGN_IN_LABEL);
    expect(signedOut).toContain(`href="${PELITA_YUU_SIGN_IN_HREF}"`);
    expect(signedOut).not.toContain(`>${YUU_BUY_LABEL}<`);
    expect(signedOut).toContain("Not at Pelita");
    expect(signedOut).toContain("Also at Pelita");
    expect(PELITA_YUU_PATH).toBe("/pelita/yuu");

    const signedIn = html({ name: "Ada" });
    expect(signedIn).toContain(YUU_BUY_LABEL);
    expect(signedIn).not.toContain(YUU_SIGN_IN_LABEL);
    expect(signedIn).toContain('aria-label="yuu store"');
    expect(signedIn).toContain("Pelita Singapore");
    expect(signedIn).toContain("Harbour Mart");
    expect(signedIn).toContain('value="harbour-mart"');
    for (const store of YUU_STORES) {
      expect(signedIn).toContain(`value="${store.id}"`);
      expect(signedIn).toContain(store.name);
    }
    for (const [id, name, price] of [
      ["PL-20068", "Zinc 25 mg", "S$14.90"],
      ["PL-20071", "Turmeric curcumin", "S$24.50"],
      ["PL-20084", "Vitamin B complex", "S$16.50"],
      ["PL-80041", "Collagen peptides powder", "S$42.90"],
      ["PL-80053", "Melatonin-free sleep gummies", "S$18.90"],
    ] as const) {
      const card = partnerCard(signedIn, id);
      expect(card.startsWith(`data-yuu-partner="${id}"`)).toBe(true);
      expect(card).toContain(name);
      expect(card).toContain(price);
      expect(card).toContain("Not at Pelita");
      expect(card).not.toContain("Also at Pelita");
      expect(card).toContain(`data-yuu-buy="${id}"`);
      expect(card).toContain(YUU_BUY_LABEL);
      expect(card).toContain("data-product-art");
    }
    expect(signedIn).toContain(`href="${PELITA_SIGN_OUT_HREF}"`);
    expect(signedIn).not.toContain("returnTo=%2Fpelita%2Fyuu");
    expect(signedIn.match(new RegExp(YUU_BUY_LABEL, "g"))).toHaveLength(scenario.storefront.yuuPartners.productIds.length);
  });

  it("states a bought purchase and an error inline", () => {
    expect(yuuBoughtLine(32)).toBe("Bought with yuu, +32 points");
    const bought = renderToStaticMarkup(createElement(YuuBuyFeedback, { note: { kind: "ok", points: 32 } }));
    expect(bought).toContain('data-yuu-bought');
    expect(bought).toContain("Bought with yuu, +32 points");
    const failed = renderToStaticMarkup(createElement(YuuBuyFeedback, { note: { kind: "error", text: "Could not record the yuu purchase." } }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('data-yuu-error');
    expect(failed).toContain("Could not record the yuu purchase.");
  });
});
