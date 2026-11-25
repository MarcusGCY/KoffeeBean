/** Shared yuu (simulated) shapes. Safe to import from client components. */

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
  personas: YuuPersonaChoice[];
  /** The signed-in shopper's member, when they already have one. */
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
