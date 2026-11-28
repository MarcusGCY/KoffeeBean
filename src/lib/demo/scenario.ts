import { z } from "zod";
import raw from "@/data/demo-scenario.json";

const money = z.number().nonnegative();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);

const catalogueItem = z.object({
  id: z.string().regex(/^PL-\d{5}$/),
  name: z.string().min(1),
  category: z.string().min(1),
  subcategory: z.string().optional(),
  size: z.string().min(1),
  price: money,
  salePrice: money.optional(),
  unitPrice: z.string().nullable(),
  promo: z.object({ kind: z.enum(["pct_off", "multibuy", "nth_off"]), ribbon: z.string().min(1) }).nullable(),
  memberPrice: money.nullable(),
  stock: z.object({
    status: z.enum(["in", "low", "out", "unlisted"]),
    qty: z.number().int().nonnegative().nullable(),
  }),
  onlineStockAfterLaunch: z.number().int().positive().optional(),
  supplier: z.string().min(1),
  tags: z.array(z.enum(["New", "Bestseller"])),
  art: z.string().min(1),
  launchedInDemo: z.boolean().optional(),
});

const approver = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  initials: z.string().min(1),
  role: z.string().min(1),
  roleDetail: z.string().min(1),
  slot: z.union([z.literal(1), z.literal(2)]),
  approvalId: z.string().regex(/^APR-\d+$/),
});

const auditRow = z.object({
  at: iso,
  actorKind: z.enum(["agent", "human", "system"]),
  actor: z.string().min(1),
  action: z.string().min(1),
  source: z.string().min(1),
  ref: z.string().nullable(),
});

export const scenarioSchema = z
  .object({
    isDemo: z.literal(true),
    demoTag: z.literal("DEMO DATA"),
    track: z.literal("pelita"),
    brand: z.object({
      name: z.string().min(1),
      wordmark: z.string().min(1),
      wordmarkSub: z.string().min(1),
      tagline: z.string().min(1),
      currency: z.literal("SGD"),
      gstRate: z.number().positive().lt(1),
      font: z.string().min(1),
      palette: z.record(z.string(), z.string().regex(/^#[0-9A-Fa-f]{6}$/)),
    }),
    storefront: z.object({
      utilityBar: z.object({ left: z.array(z.string()), right: z.array(z.string()) }),
      searchPlaceholder: z.string(),
      categories: z.array(z.string()).length(8),
      hero: z.object({ kicker: z.string(), headline: z.string(), cta: z.string() }),
      sideBanner: z.object({ kicker: z.string(), headline: z.string(), cta: z.string() }),
      dealsOfTheWeek: z.object({ countdown: z.string(), productIds: z.array(z.string()).length(5) }),
      publishedRow: z.object({
        category: z.string(),
        productIds: z.array(z.string()).length(5),
        chips: z.array(z.string()),
      }),
      /** Coalition yuu products, including partner-only skus Pelita does not stock. */
      yuuPartners: z.object({
        productIds: z.array(z.string().regex(/^PL-\d{5}$/)).min(1).max(8),
      }),
    }),
    catalogue: z.array(catalogueItem).length(25),
    gap: z.object({
      id: z.string(),
      query: z.string(),
      windowDays: z.number().int().positive(),
      searches: z.number().int().positive(),
      matchingProductsInStock: z.number().int().nonnegative(),
      noPurchasePct: z.number().min(0).max(100),
      searchesPerDay: z.array(z.number().int().positive()).length(14),
      seriesStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      seriesEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      chartMax: z.number().int().positive(),
      seriesStartLabel: z.string(),
      seriesEndLabel: z.string(),
      detectedAt: iso,
      detectedLabel: z.string(),
      headline: z.string(),
      sources: z.array(z.string()),
    }),
    proposal: z.object({
      productId: z.string(),
      title: z.string(),
      price: money,
      unitPrice: z.string(),
      supplier: z.string(),
      supplierIsLocal: z.boolean(),
      proposedAt: iso,
      forecast: z.object({
        unitsPerWeek: z.number().int().positive(),
        grossMarginPct: z.number(),
        netPriceExGst: money,
        unitCost: money,
        confidence: z.string(),
        confidencePct: z.number(),
      }),
    }),
    sourcing: z.object({
      maxUnits: z.number().int().positive(),
      approxWeeks: z.number().positive(),
      spendLimit: money,
      approvalId: z.string(),
      checkboxLabel: z.string(),
    }),
    supplier: z.object({
      name: z.string(),
      local: z.boolean(),
      source: z.string(),
      availableUnits: z.number().int().positive(),
      leadTimeDays: z.number().int().positive(),
      costPrice: money,
      costBasis: z.string(),
      moq: z.number().int().positive(),
    }),
    erp: z.object({
      source: z.string(),
      dc: z.string(),
      dcStock: z.number().int().nonnegative(),
      dcStockHeldFor: z.string(),
      moveToOnline: z.number().int().positive(),
      checkedAt: iso,
      checkedLabel: z.string(),
    }),
    purchaseOrder: z.object({
      id: z.string(),
      units: z.number().int().positive(),
      unitCost: money,
      total: money,
      underLimit: z.boolean(),
      draftedAt: iso,
    }),
    claimsCheck: z.object({
      id: z.string(),
      ruleset: z.string(),
      disclaimer: z.string(),
      status: z.literal("passed"),
      removedCount: z.number().int().nonnegative(),
      removed: z.array(z.object({ claim: z.string(), reason: z.string() })),
      kept: z.array(z.string()),
      checkedAt: iso,
    }),
    listing: z.object({
      id: z.string(),
      productId: z.string(),
      title: z.string(),
      description: z.string(),
      category: z.string(),
      price: money,
      unitPrice: z.string(),
      onlineStock: z.number().int().positive(),
      draftedAt: iso,
    }),
    promo: z.object({
      kind: z.literal("multibuy"),
      qty: z.number().int().positive(),
      bundlePrice: money,
      ribbon: z.string(),
      startsOn: z.string(),
      endsOn: z.string(),
      runsLabel: z.string(),
      perUnit: money,
      netPerUnitExGst: money,
      marginPct: z.number(),
      marginFloorPct: z.number(),
      projectedWeek1Sales: money,
    }),
    approvers: z.array(approver).length(2),
    launchApproval: z.object({ approvalId: z.string(), checkboxLabel: z.string() }),
    published: z.object({
      liveAt: iso,
      toastTitle: z.string(),
      toastLine1: z.string(),
      toastLine2: z.string(),
      searchProof: z.object({
        query: z.string(),
        resultsBefore: z.number().int().nonnegative(),
        resultsAfter: z.number().int().nonnegative(),
      }),
    }),
    timing: z.object({
      detectedAt: iso,
      liveAt: iso,
      totalSeconds: z.number().int().positive(),
      totalLabel: z.string(),
      agentSteps: z.number().int().positive(),
      humanApprovals: z.number().int().positive(),
    }),
    audit: z.array(auditRow).min(1),
    pitchLine: z.string(),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set(s.catalogue.map((item) => item.id));
    if (ids.size !== s.catalogue.length) issue("catalogue ids must be unique");
    for (const id of [...s.storefront.dealsOfTheWeek.productIds, ...s.storefront.publishedRow.productIds]) {
      if (!ids.has(id)) issue(`storefront references unknown product ${id}`);
    }
    const partners = s.storefront.yuuPartners.productIds;
    if (new Set(partners).size !== partners.length) issue("yuu partner products must be unique");
    for (const id of partners) {
      if (!ids.has(id)) issue(`yuu partner shelf references unknown product ${id}`);
    }
    if (!partners.includes(s.proposal.productId)) issue("yuu partner shelf must include the demand-gap product");
    if (!ids.has(s.proposal.productId)) issue("proposal references an unknown product");
    if (s.listing.productId !== s.proposal.productId) issue("listing and proposal must be the same product");
    if (s.approvers[0].id === s.approvers[1].id) issue("the two approvers must be different people");
    if (s.approvers[0].approvalId !== s.sourcing.approvalId) issue("approval 1 id mismatch");
    if (s.approvers[1].approvalId !== s.launchApproval.approvalId) issue("approval 2 id mismatch");
    const series = s.gap.searchesPerDay;
    if (series.reduce((sum, n) => sum + n, 0) !== s.gap.searches) {
      issue("gap.searchesPerDay must sum to gap.searches");
    }
    if (Math.max(...series) > s.gap.chartMax) issue("gap.chartMax must be at least the highest daily value");
    const days = (Date.parse(s.gap.seriesEndDate) - Date.parse(s.gap.seriesStartDate)) / 86_400_000 + 1;
    if (days !== series.length) issue("gap series dates must span exactly one day per value");
    if (s.gap.seriesEndDate !== s.gap.detectedAt.slice(0, 10)) issue("gap series must end on the detection day");
    const elapsed = (Date.parse(s.timing.liveAt) - Date.parse(s.timing.detectedAt)) / 1000;
    if (elapsed !== s.timing.totalSeconds) issue("timing.totalSeconds must equal liveAt - detectedAt");
    if (s.audit.filter((row) => row.actorKind === "agent").length !== s.timing.agentSteps) {
      issue("timing.agentSteps must equal the agent audit rows");
    }
    if (s.audit.filter((row) => row.actorKind === "human").length !== s.timing.humanApprovals) {
      issue("timing.humanApprovals must equal the human audit rows");
    }
    if (s.purchaseOrder.units * s.purchaseOrder.unitCost !== s.purchaseOrder.total) {
      issue("purchase order total must be units x unit cost");
    }
    if ((s.purchaseOrder.total <= s.sourcing.spendLimit) !== s.purchaseOrder.underLimit) {
      issue("purchaseOrder.underLimit disagrees with the spend limit");
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;
export type CatalogueItem = Scenario["catalogue"][number];

/** Parses an unknown value into the scenario type or throws a readable error. */
export function parseScenario(value: unknown): Scenario {
  const result = scenarioSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join(".") || "(root)";
    throw new Error(`Invalid demo scenario at ${where}: ${first?.message ?? "unknown error"}`);
  }
  return result.data;
}

let cached: Scenario | undefined;

/** The validated fixture. Parsed once per server instance. */
export function loadScenario(): Scenario {
  cached ??= parseScenario(raw);
  return cached;
}
