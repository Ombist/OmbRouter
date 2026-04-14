import { paymentStore } from "../payment-context.js";
import { logUsage, type UsageEntry } from "../../logger.js";
import {
  calculateModelCost,
  type ModelPricing,
  type RoutingDecision,
} from "../../router/index.js";
import { BLOCKRUN_MODELS } from "../../models.js";
import { FREE_MODELS } from "./free-models.js";

/**
 * Fire-and-forget usage log after a chat completion request (success path).
 * Uses x402 payment from AsyncLocalStorage when present; else local cost estimate.
 */
export function logCompletionsUsageAfterSuccess(input: {
  routingDecision: RoutingDecision | undefined;
  modelId: string;
  bodyLength: number;
  maxTokens: number;
  modelPricing: Map<string, ModelPricing>;
  routingProfile: "eco" | "auto" | "premium" | null;
  startTime: number;
  requestHadError: boolean;
  responseInputTokens?: number;
  responseOutputTokens?: number;
}): void {
  const {
    routingDecision,
    modelId,
    bodyLength,
    maxTokens,
    modelPricing,
    routingProfile,
    startTime,
    requestHadError,
    responseInputTokens,
    responseOutputTokens,
  } = input;

  const logModel = routingDecision?.model ?? modelId;
  if (!logModel) return;

  const actualPayment = paymentStore.getStore()?.amountUsd ?? 0;

  let logCost: number;
  let logBaseline: number;
  let logSavings: number;
  if (actualPayment > 0) {
    logCost = actualPayment;
    const chargedInputTokens = Math.ceil(bodyLength / 4);
    const modelDef = BLOCKRUN_MODELS.find((m) => m.id === logModel);
    const chargedOutputTokens = modelDef ? Math.min(maxTokens, modelDef.maxOutput) : maxTokens;
    const baseline = calculateModelCost(
      logModel,
      modelPricing,
      chargedInputTokens,
      chargedOutputTokens,
      routingProfile ?? undefined,
    );
    logBaseline = baseline.baselineCost;
    logSavings = logBaseline > 0 ? Math.max(0, (logBaseline - logCost) / logBaseline) : 0;
  } else {
    const chargedInputTokens = Math.ceil(bodyLength / 4);
    const costs = calculateModelCost(
      logModel,
      modelPricing,
      chargedInputTokens,
      maxTokens,
      routingProfile ?? undefined,
    );
    logCost = FREE_MODELS.has(logModel) ? 0 : costs.costEstimate;
    logBaseline = costs.baselineCost;
    logSavings = FREE_MODELS.has(logModel) ? 1 : costs.savings;
  }

  const entry: UsageEntry = {
    timestamp: new Date().toISOString(),
    model: logModel,
    tier: routingDecision?.tier ?? "DIRECT",
    cost: logCost,
    baselineCost: logBaseline,
    savings: logSavings,
    latencyMs: Date.now() - startTime,
    status: requestHadError ? "error" : "success",
    ...(responseInputTokens !== undefined && { inputTokens: responseInputTokens }),
    ...(responseOutputTokens !== undefined && { outputTokens: responseOutputTokens }),
  };
  logUsage(entry).catch(() => {});
}
