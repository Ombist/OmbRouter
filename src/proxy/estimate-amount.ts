import { BLOCKRUN_MODELS } from "../models.js";
import type { ModelPricing } from "../router/selector.js";
import { buildEffectiveModelPricing } from "../pricing/cost-config.js";
import { computeTieredInputCostUsd, computeTieredOutputCostUsd } from "../pricing/tiered-input.js";

export type EstimateAmountFn = (
  modelId: string,
  bodyLength: number,
  maxTokens: number,
) => string | undefined;

/**
 * Estimate USDC cost for a request based on merged model pricing.
 * Returns amount string in USDC smallest unit (6 decimals) or undefined if unknown.
 */
export function createEstimateAmount(modelPricing: Map<string, ModelPricing>): EstimateAmountFn {
  return (modelId: string, bodyLength: number, maxTokens: number): string | undefined => {
    const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
    if (!model) return undefined;

    const pricing = modelPricing.get(modelId);
    if (!pricing) return undefined;

    let costUsd: number;
    if (pricing.flatPrice !== undefined) {
      costUsd = pricing.flatPrice;
    } else {
      const estimatedInputTokens = Math.ceil(bodyLength / 4);
      const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;
      const inputCost = computeTieredInputCostUsd(estimatedInputTokens, {
        inputPrice: pricing.inputPrice,
        inputTiers: pricing.inputTiers,
      });
      const outputCost = computeTieredOutputCostUsd(estimatedOutputTokens, {
        outputPrice: pricing.outputPrice,
        outputTiers: pricing.outputTiers,
      });
      costUsd = inputCost + outputCost;
    }

    const amountMicros = Math.max(1000, Math.ceil(costUsd * 1.2 * 1_000_000));
    return amountMicros.toString();
  };
}

let defaultEstimateAmountFn: EstimateAmountFn | undefined;

/**
 * Default estimator using built-in BLOCKRUN_MODELS pricing only (no cost_config file).
 * Lazily cached for programmatic callers and tests.
 */
export function estimateAmount(modelId: string, bodyLength: number, maxTokens: number): string | undefined {
  if (!defaultEstimateAmountFn) {
    defaultEstimateAmountFn = createEstimateAmount(buildEffectiveModelPricing(undefined));
  }
  return defaultEstimateAmountFn(modelId, bodyLength, maxTokens);
}
