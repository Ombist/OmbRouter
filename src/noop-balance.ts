/**
 * No-op balance monitor for API-key / self-hosted mode (no on-chain wallet).
 */

export type BalanceInfo = {
  balance: bigint;
  balanceUSD: string;
  isLow: boolean;
  isEmpty: boolean;
  walletAddress: string;
};

export type SufficiencyResult = {
  sufficient: boolean;
  info: BalanceInfo;
  shortfall?: string;
};

const INFO: BalanceInfo = {
  balance: 0n,
  balanceUSD: "$0.00",
  isLow: false,
  isEmpty: false,
  walletAddress: "n/a",
};

/**
 * Always sufficient; used so proxy balance / fallback paths stay inert.
 */
export class NoopBalanceMonitor {
  async checkBalance(): Promise<BalanceInfo> {
    return { ...INFO };
  }

  async checkSufficient(_amountMicros: string | bigint): Promise<SufficiencyResult> {
    return { sufficient: true, info: { ...INFO } };
  }

  deductEstimated(_amountMicros: string | bigint): void {}

  invalidate(): void {}
}
