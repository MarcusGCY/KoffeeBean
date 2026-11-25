import { describe, expect, it } from "vitest";
import raw from "@/data/demo-scenario.json";
import { loadScenario, parseScenario } from "@/lib/demo/scenario";

describe("demo scenario fixture", () => {
  const scenario = loadScenario();

  it("validates and is tagged as demo data", () => {
    expect(scenario.isDemo).toBe(true);
    expect(scenario.demoTag).toBe("DEMO DATA");
    expect(scenario.brand.name).toBe("Pelita Health & Beauty");
  });

  it("has the 20-item catalogue with unique ids and the launch product unlisted", () => {
    expect(scenario.catalogue).toHaveLength(20);
    expect(new Set(scenario.catalogue.map((item) => item.id)).size).toBe(20);
    const magnesium = scenario.catalogue.find((item) => item.id === "PL-20055");
    expect(magnesium).toMatchObject({
      name: "Magnesium Glycinate 400 mg",
      price: 32.9,
      stock: { status: "unlisted", qty: 0 },
      onlineStockAfterLaunch: 300,
      tags: ["New"],
      art: "magnesium",
    });
    expect(scenario.catalogue.filter((item) => item.stock.status === "low").map((item) => item.id)).toEqual([
      "PL-20042",
      "PL-30017",
    ]);
  });

  it("carries the story numbers from SPEC.md", () => {
    expect(scenario.gap.searches).toBe(2180);
    expect(scenario.gap.matchingProductsInStock).toBe(0);
    expect(scenario.gap.noPurchasePct).toBe(64);
    expect(scenario.gap.searchesPerDay).toEqual([96, 104, 112, 121, 130, 136, 149, 157, 166, 175, 189, 199, 216, 230]);
    expect(scenario.gap).toMatchObject({
      seriesStartDate: "2026-11-12",
      seriesEndDate: "2026-11-25",
      seriesStartLabel: "12 Nov",
      chartMax: 250,
    });
    expect(scenario.promo.bundlePrice).toBe(55.9);
    expect(scenario.promo.ribbon).toBe("2 for S$55.90");
    expect(scenario.sourcing.spendLimit).toBe(11500);
    expect(scenario.purchaseOrder).toMatchObject({ id: "PO-61207", units: 600, total: 11100 });
    expect(scenario.erp).toMatchObject({ dcStock: 1200, moveToOnline: 300 });
    expect(scenario.supplier).toMatchObject({ availableUnits: 6000, leadTimeDays: 3, costPrice: 18.5, moq: 480 });
    expect(scenario.timing).toMatchObject({ totalSeconds: 431, totalLabel: "7 min 11 s", agentSteps: 6, humanApprovals: 2 });
  });

  it("has a daily series that sums to the headline search count", () => {
    const sum = scenario.gap.searchesPerDay.reduce((total, n) => total + n, 0);
    expect(sum).toBe(scenario.gap.searches);
    expect(sum).toBe(2180);
  });

  it("removes the cures-insomnia claim and records the check id", () => {
    expect(scenario.claimsCheck.id).toBe("CMP-0412");
    expect(scenario.claimsCheck.removed).toEqual([{ claim: "cures insomnia", reason: "medicinal claim" }]);
    expect(scenario.listing.description.toLowerCase()).not.toContain("cures");
    expect(scenario.listing.description).toContain("Supports relaxation and restful sleep");
  });

  it("has both mock approvers, and they are different people", () => {
    const [first, second] = scenario.approvers;
    expect(first).toMatchObject({ name: "Mei Ling Goh", role: "Category Manager", approvalId: "APR-2051", slot: 1 });
    expect(second).toMatchObject({ name: "Arjun Menon", role: "Head of E-commerce", approvalId: "APR-2052", slot: 2 });
    expect(first.id).not.toBe(second.id);
  });

  it("has the 9-row audit trail in time order", () => {
    expect(scenario.audit).toHaveLength(9);
    const times = scenario.audit.map((row) => Date.parse(row.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(scenario.audit.at(-1)).toMatchObject({ actorKind: "system", ref: "LIVE" });
  });

  it("rejects a fixture that is not marked demo or breaks a rule", () => {
    const clone = () => structuredClone(raw) as Record<string, unknown>;
    expect(() => parseScenario({ ...clone(), isDemo: false })).toThrow(/isDemo/);
    expect(() => parseScenario({ ...clone(), catalogue: (raw.catalogue as unknown[]).slice(1) })).toThrow(/catalogue/);
    const sameApprover = clone() as { approvers: { id: string }[] };
    sameApprover.approvers[1].id = sameApprover.approvers[0].id;
    expect(() => parseScenario(sameApprover)).toThrow(/different people/);
    const offSum = clone() as { gap: { searchesPerDay: number[] } };
    offSum.gap.searchesPerDay[0] += 1;
    expect(() => parseScenario(offSum)).toThrow(/sum to gap.searches/);
    const overLimit = clone() as { sourcing: { spendLimit: number } };
    overLimit.sourcing.spendLimit = 5000;
    expect(() => parseScenario(overLimit)).toThrow(/underLimit/);
  });
});
