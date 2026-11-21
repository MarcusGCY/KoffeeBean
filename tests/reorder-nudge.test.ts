import { describe, expect, it } from "vitest";
import catalog from "@/data/products.json";
import { estimateReorder, suggestNextBean, type NudgeOrder, type NudgeProduct } from "@/lib/reorder-nudge";
import { ROASTS, type Product, type Roast } from "@/lib/types";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function order(createdDaysAgo: number, items: [string, number][], cancelled = false): NudgeOrder {
  return {
    createdAt: daysAgo(createdDaysAgo),
    cancelledAt: cancelled ? daysAgo(createdDaysAgo - 0.5) : null,
    items: items.map(([productId, qty]) => ({ productId, qty })),
  };
}

function bean(id: string, roast: Roast, origin: string, notes: string[], grams: number): NudgeProduct {
  return { id, name: id.toUpperCase(), category: "beans", attributes: { roast, origin, notes, grams } };
}

const MUG: NudgeProduct = { id: "mug", name: "Mug", category: "merch" };
const A = bean("a", "light", "Ethiopia", ["floral", "citrus"], 250);
const B = bean("b", "light", "Kenya", ["berry", "citrus"], 200);
const C = bean("c", "dark", "Blend", ["chocolate"], 1000);
const D = bean("d", "medium", "Colombia", ["caramel"], 250);
const FIXTURE = [MUG, A, B, C, D];

describe("catalog bean attributes", () => {
  const products = catalog as Product[];
  const beans = products.filter((p) => p.category === "beans");

  it("gives every bean valid attributes whose grams match the name", () => {
    expect(beans.length).toBeGreaterThan(0);
    for (const p of beans) {
      const a = p.attributes;
      expect(a, p.id).toBeDefined();
      expect(ROASTS, p.id).toContain(a!.roast);
      expect(a!.origin.trim(), p.id).not.toBe("");
      expect(a!.notes.length, p.id).toBeGreaterThan(0);
      expect(a!.notes.every((n) => n.trim() !== ""), p.id).toBe(true);
      expect(Number.isInteger(a!.grams) && a!.grams > 0, p.id).toBe(true);
      const size = /(\d+)\s?(kg|g)\b/i.exec(p.name);
      expect(size, p.id).not.toBeNull();
      const named = Number(size![1]) * (size![2].toLowerCase() === "kg" ? 1000 : 1);
      expect(a!.grams, p.id).toBe(named);
    }
  });

  it("leaves merch without attributes", () => {
    for (const p of products.filter((x) => x.category === "merch")) expect(p.attributes, p.id).toBeUndefined();
  });

  it("keeps ids unique", () => {
    expect(new Set(products.map((p) => p.id)).size).toBe(products.length);
  });
});

describe("estimateReorder", () => {
  it("returns null with no orders, null input, or no bean orders", () => {
    expect(estimateReorder([], FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder(null, FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder([order(2, [["mug", 1]])], FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder([order(2, [["gone", 1]])], FIXTURE, { now: NOW })).toBeNull();
  });

  it("computes days since order, grams bought and days left", () => {
    // 250 g x 2 = 500 g at 15 g/day = 33.3 days of supply, 10 days elapsed.
    const est = estimateReorder([order(10, [["a", 2]])], FIXTURE, { now: NOW })!;
    expect(est.daysSinceOrder).toBe(10);
    expect(est.gramsBought).toBe(500);
    expect(est.gramsPerDay).toBe(15);
    expect(est.estimatedDaysLeft).toBe(24);
    expect(est.due).toBe(false);
    expect(est.productIds).toEqual(["a"]);
    expect(est.reason).toContain("assuming ~15 g/day");
    expect(est.reason).toContain("500 g");
    expect(est.reason).toContain("10 days ago");
    expect(est.reason).toContain("about 24 days left");
    expect(est.reason).not.toContain("Time to reorder");
  });

  it("is due once about 3 days or fewer remain", () => {
    // 250 g / 15 = 16.67 days of supply.
    const at = (days: number) => estimateReorder([order(days, [["a", 1]])], FIXTURE, { now: NOW })!;
    expect(at(12).estimatedDaysLeft).toBe(5);
    expect(at(12).due).toBe(false);
    expect(at(13).estimatedDaysLeft).toBe(4);
    expect(at(13).due).toBe(false);
    expect(at(14).estimatedDaysLeft).toBe(3);
    expect(at(14).due).toBe(true);
    expect(at(14).reason).toContain("Time to reorder");
  });

  it("reports running out today and overdue orders", () => {
    const today = estimateReorder([order(17, [["a", 1]])], FIXTURE, { now: NOW })!;
    expect(today.estimatedDaysLeft).toBe(0);
    expect(Object.is(today.estimatedDaysLeft, 0)).toBe(true);
    expect(today.due).toBe(true);
    expect(today.reason).toContain("likely running out today");

    const late = estimateReorder([order(20, [["a", 1]])], FIXTURE, { now: NOW })!;
    expect(late.estimatedDaysLeft).toBe(-3);
    expect(late.due).toBe(true);
    expect(late.reason).toContain("likely ran out 3 days ago");

    const one = estimateReorder([order(18, [["a", 1]])], FIXTURE, { now: NOW })!;
    expect(one.reason).toContain("likely ran out 1 day ago");
  });

  it("honours a custom gramsPerDay and states it in the reason", () => {
    const est = estimateReorder([order(10, [["a", 1]])], FIXTURE, { now: NOW, gramsPerDay: 25 })!;
    expect(est.gramsPerDay).toBe(25);
    expect(est.estimatedDaysLeft).toBe(0);
    expect(est.reason).toContain("assuming ~25 g/day");
  });

  it("falls back to 15 g/day for a non-positive or non-finite rate", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const est = estimateReorder([order(1, [["a", 1]])], FIXTURE, { now: NOW, gramsPerDay: bad })!;
      expect(est.gramsPerDay).toBe(15);
      expect(est.reason).toContain("assuming ~15 g/day");
    }
  });

  it("uses the most recent bean order regardless of array order", () => {
    const orders = [order(30, [["c", 1]]), order(5, [["a", 1]]), order(15, [["d", 1]])];
    const est = estimateReorder(orders, FIXTURE, { now: NOW })!;
    expect(est.productIds).toEqual(["a"]);
    expect(est.daysSinceOrder).toBe(5);
    expect(est.orderedAt).toBe(daysAgo(5));
  });

  it("ignores cancelled orders, even when they are the most recent", () => {
    const orders = [order(20, [["a", 1]]), order(1, [["c", 1]], true)];
    const est = estimateReorder(orders, FIXTURE, { now: NOW })!;
    expect(est.productIds).toEqual(["a"]);
    expect(est.daysSinceOrder).toBe(20);
    expect(estimateReorder([order(1, [["c", 1]], true)], FIXTURE, { now: NOW })).toBeNull();
  });

  it("skips a newer merch-only order and sums beans within one order", () => {
    const orders = [order(2, [["mug", 3]]), order(8, [["a", 1], ["mug", 1], ["c", 1], ["a", 1]])];
    const est = estimateReorder(orders, FIXTURE, { now: NOW })!;
    expect(est.gramsBought).toBe(250 + 1000 + 250);
    expect(est.productIds).toEqual(["a", "c"]);
    expect(est.daysSinceOrder).toBe(8);
  });

  it("ignores invalid dates and quantities", () => {
    const bad: NudgeOrder = { createdAt: "not-a-date", cancelledAt: null, items: [{ productId: "a", qty: 1 }] };
    expect(estimateReorder([bad], FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder([order(1, [["a", 0]])], FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder([order(1, [["a", 1.5]])], FIXTURE, { now: NOW })).toBeNull();
    expect(estimateReorder([order(1, [["a", -2]])], FIXTURE, { now: NOW })).toBeNull();
  });

  it("clamps an order dated after now to zero days", () => {
    const future: NudgeOrder = { createdAt: new Date(NOW.getTime() + 2 * DAY).toISOString(), items: [{ productId: "a", qty: 1 }] };
    const est = estimateReorder([future], FIXTURE, { now: NOW })!;
    expect(est.daysSinceOrder).toBe(0);
    expect(est.estimatedDaysLeft).toBe(17);
  });

  it("does not depend on the real clock", () => {
    const orders = [order(10, [["a", 1]])];
    const first = estimateReorder(orders, FIXTURE, { now: NOW });
    const second = estimateReorder(orders, FIXTURE, { now: NOW });
    expect(second).toEqual(first);
    const later = estimateReorder(orders, FIXTURE, { now: new Date(NOW.getTime() + 5 * DAY) })!;
    expect(later.daysSinceOrder).toBe(15);
  });

  it("works on the real catalog", () => {
    const est = estimateReorder([order(10, [["espresso-1kg", 1]])], catalog as Product[], { now: NOW })!;
    expect(est.gramsBought).toBe(1000);
    expect(est.estimatedDaysLeft).toBe(57);
  });
});

describe("suggestNextBean", () => {
  it("never suggests merch and returns null when there is no candidate", () => {
    expect(suggestNextBean([], [MUG], [], { now: NOW })).toBeNull();
    expect(suggestNextBean(null, [], null, { now: NOW })).toBeNull();
    const all = [order(1, [["a", 1], ["b", 1], ["c", 1], ["d", 1]])];
    expect(suggestNextBean(all, FIXTURE, [], { now: NOW })).toBeNull();
  });

  it("cold start picks the first bean in catalog order with an explicit reason", () => {
    const pick = suggestNextBean([], FIXTURE, [], { now: NOW })!;
    expect(pick.productId).toBe("a");
    expect(pick.addedCount).toBe(0);
    expect(pick.similarity).toBe(0);
    expect(pick.reason).toContain("not tried recently");
  });

  it("excludes beans bought within the recent window but not older ones", () => {
    const orders = [order(5, [["a", 1]]), order(60, [["b", 1]])];
    const pick = suggestNextBean(orders, FIXTURE, [], { now: NOW })!;
    expect(pick.productId).not.toBe("a");
    const ids = new Set<string>();
    for (const added of [["b"], ["c"], ["d"]]) ids.add(suggestNextBean(orders, FIXTURE, added, { now: NOW })!.productId);
    expect(ids).toEqual(new Set(["b", "c", "d"]));
    expect(suggestNextBean(orders, FIXTURE, ["a"], { now: NOW })!.productId).not.toBe("a");
  });

  it("respects a custom recentDays window", () => {
    const orders = [order(40, [["a", 1]])];
    expect(suggestNextBean(orders, [A], [], { now: NOW })!.productId).toBe("a");
    expect(suggestNextBean(orders, [A], [], { now: NOW, recentDays: 60 })).toBeNull();
  });

  it("ignores cancelled orders when judging what was bought", () => {
    const orders = [order(2, [["a", 1]], true)];
    expect(suggestNextBean(orders, [A], [], { now: NOW })!.productId).toBe("a");
  });

  it("ranks recommend.added history above attribute similarity", () => {
    // Bought A (light/Ethiopia). B is the closest match but D was added more.
    const orders = [order(3, [["a", 1]])];
    const pick = suggestNextBean(orders, FIXTURE, ["d", "d", "b"], { now: NOW })!;
    expect(pick.productId).toBe("d");
    expect(pick.addedCount).toBe(2);
    expect(pick.reason).toContain("added it from a recommendation 2 times");
  });

  it("uses a singular 'time' for a single add", () => {
    const pick = suggestNextBean([], FIXTURE, ["c"], { now: NOW })!;
    expect(pick.productId).toBe("c");
    expect(pick.reason).toContain("1 time before");
    expect(pick.reason).not.toContain("1 times");
  });

  it("falls back to attribute similarity and explains the match", () => {
    // Bought A (light, Ethiopia, floral+citrus). B shares light roast + citrus.
    const orders = [order(3, [["a", 1]])];
    const pick = suggestNextBean(orders, FIXTURE, [], { now: NOW })!;
    expect(pick.productId).toBe("b");
    expect(pick.similarity).toBe(2);
    expect(pick.reason).toContain("similar to A");
    expect(pick.reason).toContain("light roast");
    expect(pick.reason).toContain("citrus notes");
  });

  it("scores origin matches and counts every shared note", () => {
    const base = bean("base", "dark", "Brazil", ["nutty", "cocoa", "caramel"], 200);
    const sameOrigin = bean("origin", "light", "brazil", ["fruity"], 200);
    const notes = bean("notes", "medium", "Peru", ["Nutty", "cocoa"], 200);
    const orders = [order(2, [["base", 1]])];
    const pick = suggestNextBean(orders, [base, sameOrigin, notes], [], { now: NOW })!;
    expect(pick.productId).toBe("notes");
    expect(pick.similarity).toBe(2);
    const tie = suggestNextBean(orders, [base, sameOrigin], [], { now: NOW })!;
    expect(tie.productId).toBe("origin");
    expect(tie.reason).toContain("brazil origin");
  });

  it("breaks full ties by catalog order", () => {
    const x = bean("x", "dark", "Peru", ["nutty"], 200);
    const y = bean("y", "dark", "Chile", ["nutty"], 200);
    const base = bean("base", "dark", "Brazil", ["nutty"], 200);
    const orders = [order(2, [["base", 1]])];
    expect(suggestNextBean(orders, [base, x, y], [], { now: NOW })!.productId).toBe("x");
    expect(suggestNextBean(orders, [base, y, x], [], { now: NOW })!.productId).toBe("y");
  });

  it("ignores unknown product ids in the added history", () => {
    const pick = suggestNextBean([], FIXTURE, ["ghost", "ghost", "mug"], { now: NOW })!;
    expect(pick.productId).toBe("a");
    expect(pick.addedCount).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const orders = [order(3, [["a", 1]])];
    const added = ["d"];
    const before = JSON.stringify({ orders, added, FIXTURE });
    suggestNextBean(orders, FIXTURE, added, { now: NOW });
    estimateReorder(orders, FIXTURE, { now: NOW });
    expect(JSON.stringify({ orders, added, FIXTURE })).toBe(before);
  });

  it("works on the real catalog", () => {
    const orders = [order(3, [["ethiopia-250", 1]])];
    const pick = suggestNextBean(orders, catalog as Product[], [], { now: NOW })!;
    expect(pick.productId).toBe("kenya-ichangi-200");
    const added = suggestNextBean(orders, catalog as Product[], ["espresso-1kg"], { now: NOW })!;
    expect(added.productId).toBe("espresso-1kg");
  });
});
