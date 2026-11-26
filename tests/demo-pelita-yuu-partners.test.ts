import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PelitaPartnerPurchases } from "@/components/pelita/PelitaPartnerPurchases";
import { loadScenario } from "@/lib/demo/scenario";
import { storefrontView } from "@/lib/demo/storefront";
import { partnerOffers } from "@/lib/demo/yuu-partners";
import { PELITA_YUU_PATH, PELITA_YUU_SIGN_IN_HREF } from "@/lib/return-to";
import { YUU_BUY_LABEL, YUU_PARTNER_HEADING, YUU_SIGN_IN_LABEL } from "@/lib/yuu/types";

const scenario = loadScenario();

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
    expect(offers.filter((offer) => offer.id !== gap).every((offer) => offer.atPelita)).toBe(true);
    expect(storefrontView(scenario).catalogue.map((product) => product.id)).not.toContain(gap);

    const listed = partnerOffers(scenario, true);
    expect(listed.find((offer) => offer.id === gap)?.atPelita).toBe(true);
    expect(storefrontView(scenario, { listed: true }).catalogue.map((product) => product.id)).toContain(gap);
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
    expect(signedIn.match(new RegExp(YUU_BUY_LABEL, "g"))).toHaveLength(scenario.storefront.yuuPartners.productIds.length);
  });
});
