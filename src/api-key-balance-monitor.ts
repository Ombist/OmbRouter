/**
 * No-op balance monitor for apiKey upstream mode (no on-chain wallet).
 */
import type { BalanceInfo, SufficiencyResult } from "./balance.js";

const PLACEHOLDER = "api-key";

export class ApiKeyBalanceMonitor {
  async checkBalance(): Promise<BalanceInfo> {
    return {
      balance: 0n,
      balanceUSD: "$0.00",
      isLow: false,
      isEmpty: false,
      walletAddress: PLACEHOLDER,
    };
  }

  async checkSufficient(_estimatedCostMicros: bigint): Promise<SufficiencyResult> {
    const info = await this.checkBalance();
    return { sufficient: true, info };
  }

  deductEstimated(_amountMicros: bigint): void {}

  invalidate(): void {}
}
