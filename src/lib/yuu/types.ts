/**
 * Shared yuu shapes. Safe to import from client components.
 * The programme is simulated (it is not DFI yuu). Shoppers are real signed-in accounts.
 */

export const YUU_LABEL = "yuu (simulated)" as const;

export type YuuTierName = "Member" | "Silver" | "Gold";
export type YuuChannel = "web" | "sim";
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
