/**
 * Balance monitor for MoonPay CLI mode: no Base USDC RPC from OmbRouter.
 * Use `mp token balance list` for real balances; health shows wallet label only.
 */
import type { BalanceInfo, SufficiencyResult } from "./balance.js";

export class MoonPayBalanceMonitor {
  constructor(private readonly walletLabel: string) {}

  async checkBalance(): Promise<BalanceInfo> {
    return {
      balance: 0n,
      balanceUSD: "n/a (MoonPay CLI)",
      isLow: false,
      isEmpty: false,
      walletAddress: `moonpay:${this.walletLabel}`,
    };
  }

  async checkSufficient(_estimatedCostMicros: bigint): Promise<SufficiencyResult> {
    const info = await this.checkBalance();
    return { sufficient: true, info };
  }

  deductEstimated(_amountMicros: bigint): void {}

  invalidate(): void {}
}
