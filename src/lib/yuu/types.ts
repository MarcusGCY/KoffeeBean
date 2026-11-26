/**
 * Shared yuu shapes. Safe to import from client components.
 * The programme is simulated (it is not DFI yuu). Shoppers are real signed-in accounts.
 */

export const YUU_LABEL = "yuu (simulated)" as const;

/** Visible heading on the partner shelf. */
export const YUU_PARTNER_HEADING = "yuu partner purchases";
/** Visible label on a signed-in Buy control, on the Pelita shelf and at partner stores. */
export const YUU_BUY_LABEL = "Buy with yuu";
/** Visible label when nobody is signed in. The control is a link to sign in. */
export const YUU_SIGN_IN_LABEL = "Sign in to buy with yuu";

/** Inline confirmation after a yuu purchase. `points` is the points just earned. */
export function yuuBoughtLine(points: number): string {
  return `Bought with yuu, +${points} points`;
}

export type YuuTierName = "Member" | "Silver" | "Gold";
/** `partner` is a coalition purchase at another store. `sim` is only on old rows. */
export type YuuChannel = "web" | "partner" | "sim";
export type YuuPurchaseChannel = "web" | "partner";
export type YuuSignalStatus = "dropped" | "shortlisted" | "escalated";
export type YuuSignalSource = "detector" | "bi_bot";

export type YuuPersonaChoice = {
  id: string;
  displayName: string;
  points: number;
  tier: YuuTierName;
};

export type StorefrontYuu = {
  /** The signed-in shopper's balance. Null when they are signed out or have not bought. */
  signedInMember: YuuPersonaChoice | null;
};

export type YuuPurchaseResult = {
  label: typeof YUU_LABEL;
  memberId: string;
  displayName: string;
  sku: string;
  productName: string;
  qty: number;
  amountSgd: string;
  pointsEarned: number;
  points: number;
  tier: YuuTierName;
  channel: YuuChannel;
};

export type YuuSignalView = {
  id: string;
  sku: string;
  productName: string;
  score: number;
  windowMinutes: number;
  distinctMembers: number;
  totalQty: number;
  status: YuuSignalStatus;
  reason: string | null;
  source: YuuSignalSource;
  proposalRef: string | null;
};

export type YuuMemberView = {
  id: string;
  displayName: string;
  points: number;
  tier: YuuTierName;
  test: boolean;
};

export type YuuPanel = {
  label: typeof YUU_LABEL;
  windowMinutes: number;
  minRepeatMembers: number;
  minScore: number;
  /** False when Auth0 returned more users than a Management API scan can read. */
  scanComplete: boolean;
  signals: YuuSignalView[];
  members: YuuMemberView[];
};

export type YuuSkuStat = {
  sku: string;
  productName: string;
  distinctMembers: number;
  repeatMembers: number;
  repeatPurchases: number;
  totalQty: number;
  totalAmountSgd: string;
  score: number;
};

export type YuuLoyaltyReport = {
  label: typeof YUU_LABEL;
  windowMinutes: number;
  minRepeatMembers: number;
  minScore: number;
  /** False when Auth0 returned more users than a Management API scan can read. */
  scanComplete: boolean;
  members: {
    count: number;
    tierMix: Record<YuuTierName, number>;
    excludedTest: number;
  };
  transactions: {
    count: number;
    totalQty: number;
    totalAmountSgd: string;
  };
  skus: YuuSkuStat[];
  signals: YuuSignalView[];
};
