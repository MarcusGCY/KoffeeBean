import { z } from "zod";

/**
 * Per-SKU e-commerce launch config for the Pelita demo.
 * Stored at `kb:demo:pelita:launch:<sku>`. Visibility is computed at read time.
 */

export const LAUNCH_KEY_PREFIX = "kb:demo:pelita:launch:";
export const LAUNCH_INDEX_KEY = `${LAUNCH_KEY_PREFIX}index`;

const SKU_RE = /^[A-Za-z0-9_-]+$/;
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoDateTime(value: string): boolean {
  return ISO_DT.test(value) && !Number.isNaN(Date.parse(value));
}

/** A relative `/path` or an `https://` URL. `javascript:` and other schemes are refused. */
export function isSafeImageUrl(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 500 || /[\u0000-\u001F\u007F\s\\]/.test(text) || text.includes("..")) return false;
  if (text.startsWith("/")) {
    if (text.startsWith("//")) return false;
    try {
      const url = new URL(text, "https://assets.invalid");
      return url.origin === "https://assets.invalid" && !url.pathname.includes("..");
    } catch {
      return false;
    }
  }
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

export function isLaunchSku(sku: string): boolean {
  return SKU_RE.test(sku) && sku.length <= 64 && sku !== "index";
}

export function launchKey(sku: string): string {
  if (!isLaunchSku(sku)) throw new Error("Invalid launch sku");
  return `${LAUNCH_KEY_PREFIX}${sku}`;
}

export function productLiveUrl(sku: string): string {
  return `/pelita/product/${encodeURIComponent(sku)}`;
}

export function productPreviewUrl(sku: string): string {
  return `${productLiveUrl(sku)}?preview=1`;
}

const isoDateTime = z.string().trim().refine(isIsoDateTime, "must be an ISO 8601 datetime");

const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(SKU_RE, "sku must use letters, numbers, _ or -")
  .refine((sku) => sku !== "index", "sku is reserved");

export const promoSchema = z
  .object({
    type: z.enum(["pct_off", "multibuy", "member_price"]),
    label: z.string().trim().min(1).max(80).optional(),
    pctOff: z.number().positive().max(100).optional(),
    buyQty: z.number().int().positive().max(20).optional(),
    bundlePriceCents: z.number().int().positive().max(10_000_000).optional(),
    memberPriceCents: z.number().int().positive().max(10_000_000).optional(),
    startsAt: isoDateTime.optional(),
    endsAt: isoDateTime.optional(),
  })
  .superRefine((promo, ctx) => {
    if (promo.startsAt && promo.endsAt && Date.parse(promo.startsAt) > Date.parse(promo.endsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be on or after startsAt" });
    }
  });

export const memberOfferSchema = z.object({
  memberPriceCents: z.number().int().positive().max(10_000_000).optional(),
  bonusPoints: z.number().int().positive().max(1_000_000).optional(),
  segmentLabel: z.string().trim().min(1).max(200).optional(),
  headline: z.string().trim().min(1).max(160).optional(),
});

export const launchConfigSchema = z
  .object({
    sku: skuSchema,
    title: z.string().trim().min(1).max(200),
    subtitle: z.string().trim().min(1).max(200).optional(),
    longCopy: z.string().trim().min(1).max(4000).optional(),
    bullets: z.array(z.string().trim().min(1).max(240)).max(12).optional(),
    size: z.string().trim().min(1).max(80).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    supplier: z.string().trim().min(1).max(120).optional(),
    imageUrl: z.string().trim().max(500).refine(isSafeImageUrl, "imageUrl must be a path starting with / or an https URL").optional(),
    shelfPriceCents: z.number().int().positive().max(10_000_000),
    promo: promoSchema.optional(),
    memberOffer: memberOfferSchema.optional(),
    stores: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    goLiveAt: isoDateTime.optional(),
    status: z.enum(["draft", "scheduled", "live"]),
  })
  .superRefine((config, ctx) => {
    if (config.status === "scheduled" && !config.goLiveAt) {
      ctx.addIssue({ code: "custom", path: ["goLiveAt"], message: "goLiveAt is required when status is scheduled" });
    }
  });

export type LaunchPromo = z.infer<typeof promoSchema>;
export type MemberOffer = z.infer<typeof memberOfferSchema>;
export type LaunchConfig = z.infer<typeof launchConfigSchema>;
export type LaunchStatus = LaunchConfig["status"];

export type LaunchIssue = { path: string; message: string };

export function launchIssues(error: z.ZodError): LaunchIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Live for shoppers when the config says so, or when a schedule's go-live instant has passed.
 * Drafts stay hidden. A schedule with no timestamp stays hidden.
 */
export function isLaunchLive(config: { status: string; goLiveAt?: string | null }, now = Date.now()): boolean {
  if (config.status === "live") return true;
  if (config.status !== "scheduled" || !config.goLiveAt) return false;
  const at = Date.parse(config.goLiveAt);
  return !Number.isNaN(at) && now >= at;
}

/** Active only inside an optional startsAt/endsAt window. Missing bounds do not hide the promo. */
export function isPromoActive(promo: { startsAt?: string; endsAt?: string } | null | undefined, now = Date.now()): boolean {
  if (!promo) return false;
  if (promo.startsAt) {
    const start = Date.parse(promo.startsAt);
    if (Number.isNaN(start) || now < start) return false;
  }
  if (promo.endsAt) {
    const end = Date.parse(promo.endsAt);
    if (Number.isNaN(end) || now > end) return false;
  }
  return true;
}

export function formatSgdCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}S$${dollars}.${String(rem).padStart(2, "0")}`;
}

/** `26 Nov 2026, 09:00 SGT` in Asia/Singapore. */
export function formatGoLiveSgt(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return `${formatted} SGT`;
}

export function targetedLabel(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return trimmed;
  return /^targeted:/i.test(trimmed) ? trimmed : `Targeted: ${trimmed}`;
}

export type PromoView = {
  type: LaunchPromo["type"];
  label: string;
  payCents: number;
  wasCents: number | null;
  memberPriceCents: number | null;
};

/** The promo a shopper should see, or null when it is outside its date window. */
export function presentPromo(promo: LaunchPromo | undefined, shelfPriceCents: number, now = Date.now()): PromoView | null {
  if (!promo || !isPromoActive(promo, now)) return null;
  if (promo.type === "pct_off") {
    const pct = promo.pctOff ?? 0;
    const pay = pct > 0 ? Math.round((shelfPriceCents * (100 - pct)) / 100) : shelfPriceCents;
    return {
      type: "pct_off",
      label: promo.label?.trim() || (pct > 0 ? `${pct}% off` : "Offer"),
      payCents: pay,
      wasCents: pay === shelfPriceCents ? null : shelfPriceCents,
      memberPriceCents: null,
    };
  }
  if (promo.type === "multibuy") {
    const label =
      promo.label?.trim() ||
      (promo.buyQty && promo.bundlePriceCents ? `${promo.buyQty} for ${formatSgdCents(promo.bundlePriceCents)}` : "Multibuy");
    return { type: "multibuy", label, payCents: shelfPriceCents, wasCents: null, memberPriceCents: null };
  }
  return {
    type: "member_price",
    label: promo.label?.trim() || "Member price",
    payCents: shelfPriceCents,
    wasCents: null,
    memberPriceCents: promo.memberPriceCents ?? null,
  };
}

/** Banner for a hidden config opened with `?preview=1`. Null once the product is actually live. */
export function launchPreviewBanner(config: { status: string; goLiveAt?: string | null }, now = Date.now()): string | null {
  if (isLaunchLive(config, now)) return null;
  if (config.status === "scheduled" && config.goLiveAt) {
    const when = formatGoLiveSgt(config.goLiveAt);
    return when ? `Scheduled to go live ${when}` : "Scheduled to go live";
  }
  return "Draft preview";
}

export type LaunchPublic = {
  sku: string;
  status: LaunchStatus;
  isLive: boolean;
  goLiveAt: string | null;
  previewUrl: string;
  liveUrl: string;
  config: LaunchConfig;
};

export function describeLaunch(config: LaunchConfig, now = Date.now()): LaunchPublic {
  return {
    sku: config.sku,
    status: config.status,
    isLive: isLaunchLive(config, now),
    goLiveAt: config.goLiveAt ?? null,
    previewUrl: productPreviewUrl(config.sku),
    liveUrl: productLiveUrl(config.sku),
    config,
  };
}

export type LaunchWriteResult = {
  ok: true;
  sku: string;
  status: LaunchStatus;
  isLive: boolean;
  goLiveAt: string | null;
  previewUrl: string;
  liveUrl: string;
};

export function launchWriteResult(config: LaunchConfig, now = Date.now()): LaunchWriteResult {
  const described = describeLaunch(config, now);
  return {
    ok: true,
    sku: described.sku,
    status: described.status,
    isLive: described.isLive,
    goLiveAt: described.goLiveAt,
    previewUrl: described.previewUrl,
    liveUrl: described.liveUrl,
  };
}

export type DraftPush = { title: string; body: string };

/** Ops-only ERP handoff. Nothing here is shown to shoppers or sent. */
export type LaunchSignalMeta = {
  id: number;
  label: string;
  handoff: string;
  supplier: string;
  erp: string;
  erpRow: number;
};

export type LaunchScheduleRow = {
  sku: string;
  title: string;
  status: LaunchStatus;
  isLive: boolean;
  goLiveAt: string | null;
  goLiveLabel: string | null;
  previewUrl: string;
  liveUrl: string;
  /** Ops-only copy. Nothing in the app sends it. */
  draftPush?: DraftPush | null;
  priceNote?: string | null;
  signal?: LaunchSignalMeta | null;
};

export function toScheduleRow(config: LaunchConfig, now = Date.now()): LaunchScheduleRow {
  const described = describeLaunch(config, now);
  return {
    sku: config.sku,
    title: config.title,
    status: described.status,
    isLive: described.isLive,
    goLiveAt: described.goLiveAt,
    goLiveLabel: config.goLiveAt ? formatGoLiveSgt(config.goLiveAt) : null,
    previewUrl: described.previewUrl,
    liveUrl: described.liveUrl,
  };
}
