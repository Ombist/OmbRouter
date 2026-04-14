import { BLOCKRUN_MODELS } from "../../models.js";
import type { RoutingDecision } from "../../router/index.js";
import type { EstimateAmountFn } from "../estimate-amount.js";
import { FREE_MODEL, FREE_MODELS } from "./free-models.js";

export type { EstimateAmountFn } from "../estimate-amount.js";

/** Strict mode: projected session spend would exceed cap */
export type StrictCostCapBlocked = {
  kind: "strict_cap";
  projectedCostUsd: number;
  runCostUsd: number;
  thisReqEstUsd: number;
  limit: number;
};

/** Graceful pre-check (before streaming headers): cannot afford any viable model */
export type GracefulPrecheckBlocked = {
  kind: "graceful_precheck";
  remainingUsd: number;
  limit: number;
  variant: "agentic" | "explicit_model";
  explicitModelId?: string;
};

export function evaluateStrictCostCap(input: {
  maxCostPerRunUsd?: number;
  effectiveSessionId?: string;
  isFreeModel: boolean;
  /** When true, USD cap also applies to free-tier models. */
  quotaIncludeFreeInUsdCap?: boolean;
  maxCostPerRunMode: "graceful" | "strict" | undefined;
  runCostUsd: number;
  modelId: string;
  bodyLength: number;
  maxTokens: number;
  estimatedCostMicros?: bigint;
  estimateAmount: EstimateAmountFn;
}): StrictCostCapBlocked | null {
  const {
    maxCostPerRunUsd,
    effectiveSessionId,
    isFreeModel,
    quotaIncludeFreeInUsdCap,
    maxCostPerRunMode,
    runCostUsd,
    modelId,
    bodyLength,
    maxTokens,
    estimatedCostMicros,
    estimateAmount,
  } = input;

  const skipForFree = isFreeModel && !quotaIncludeFreeInUsdCap;
  if (
    !maxCostPerRunUsd ||
    !effectiveSessionId ||
    skipForFree ||
    (maxCostPerRunMode ?? "graceful") !== "strict"
  ) {
    return null;
  }

  const thisReqEstStr =
    estimatedCostMicros !== undefined
      ? estimatedCostMicros.toString()
      : modelId
        ? estimateAmount(modelId, bodyLength, maxTokens)
        : undefined;
  const thisReqEstUsd = thisReqEstStr ? Number(thisReqEstStr) / 1_000_000 : 0;
  const projectedCostUsd = runCostUsd + thisReqEstUsd;
  if (projectedCostUsd <= maxCostPerRunUsd) return null;

  return {
    kind: "strict_cap",
    projectedCostUsd,
    runCostUsd,
    thisReqEstUsd,
    limit: maxCostPerRunUsd,
  };
}

export function evaluateGracefulBudgetPrecheck(input: {
  maxCostPerRunUsd?: number;
  effectiveSessionId?: string;
  isFreeModel: boolean;
  quotaIncludeFreeInUsdCap?: boolean;
  maxCostPerRunMode: "graceful" | "strict" | undefined;
  runCostUsd: number;
  hasTools: boolean;
  routingDecision: RoutingDecision | undefined;
  modelId: string;
  bodyLength: number;
  maxTokens: number;
  estimateAmount: EstimateAmountFn;
}): GracefulPrecheckBlocked | null {
  const {
    maxCostPerRunUsd,
    effectiveSessionId,
    isFreeModel,
    quotaIncludeFreeInUsdCap,
    maxCostPerRunMode,
    runCostUsd,
    hasTools,
    routingDecision,
    modelId,
    bodyLength,
    maxTokens,
    estimateAmount,
  } = input;

  const skipForFree = isFreeModel && !quotaIncludeFreeInUsdCap;
  if (
    !maxCostPerRunUsd ||
    !effectiveSessionId ||
    skipForFree ||
    (maxCostPerRunMode ?? "graceful") !== "graceful"
  ) {
    return null;
  }

  const remainingUsd = maxCostPerRunUsd - runCostUsd;
  const isComplexOrAgentic =
    hasTools || routingDecision?.tier === "COMPLEX" || routingDecision?.tier === "REASONING";

  if (isComplexOrAgentic) {
    const canAffordAnyNonFreeModel = BLOCKRUN_MODELS.some((m) => {
      if (FREE_MODELS.has(m.id)) return false;
      const est = estimateAmount(m.id, bodyLength, maxTokens);
      return est !== undefined && Number(est) / 1_000_000 <= remainingUsd;
    });
    if (!canAffordAnyNonFreeModel) {
      return {
        kind: "graceful_precheck",
        remainingUsd: Math.max(0, remainingUsd),
        limit: maxCostPerRunUsd,
        variant: "agentic",
      };
    }
  } else if (!routingDecision && modelId && !FREE_MODELS.has(modelId)) {
    const est = estimateAmount(modelId, bodyLength, maxTokens);
    const canAfford = !est || Number(est) / 1_000_000 <= remainingUsd;
    if (!canAfford) {
      return {
        kind: "graceful_precheck",
        remainingUsd: Math.max(0, remainingUsd),
        limit: maxCostPerRunUsd,
        variant: "explicit_model",
        explicitModelId: modelId,
      };
    }
  }

  return null;
}

export type GracefulBudgetFilterResult =
  | {
      outcome: "continue";
      modelsToTry: string[];
      excluded: string[];
      budgetDowngradeNotice?: string;
      budgetDowngradeHeaderMode?: "downgraded";
    }
  | {
      outcome: "block_complex_free_only";
      errPayload: { error: { message: string; type: string; code: string } };
      budgetSummary: string;
    };

/**
 * Graceful mode: filter fallback chain by remaining budget; build downgrade notices.
 * Caller handles SSE vs JSON response when outcome is block_complex_free_only.
 */
export function applyGracefulBudgetModelFilter(input: {
  modelsToTry: string[];
  maxCostPerRunUsd?: number;
  effectiveSessionId?: string;
  isFreeModel: boolean;
  quotaIncludeFreeInUsdCap?: boolean;
  maxCostPerRunMode: "graceful" | "strict" | undefined;
  runCostUsd: number;
  hasTools: boolean;
  routingDecision: RoutingDecision | undefined;
  bodyLength: number;
  maxTokens: number;
  estimateAmount: EstimateAmountFn;
  limitUsd: number;
}): GracefulBudgetFilterResult {
  const {
    modelsToTry: initial,
    maxCostPerRunUsd,
    effectiveSessionId,
    isFreeModel,
    quotaIncludeFreeInUsdCap,
    maxCostPerRunMode,
    runCostUsd,
    hasTools,
    routingDecision,
    bodyLength,
    maxTokens,
    estimateAmount,
    limitUsd,
  } = input;

  const skipForFree = isFreeModel && !quotaIncludeFreeInUsdCap;
  if (
    !maxCostPerRunUsd ||
    !effectiveSessionId ||
    skipForFree ||
    (maxCostPerRunMode ?? "graceful") !== "graceful"
  ) {
    return { outcome: "continue", modelsToTry: initial, excluded: [] };
  }

  const remainingUsd = maxCostPerRunUsd - runCostUsd;
  const beforeFilter = [...initial];
  const modelsToTry = initial.filter((m) => {
    if (FREE_MODELS.has(m) && !quotaIncludeFreeInUsdCap) return true;
    const est = estimateAmount(m, bodyLength, maxTokens);
    if (!est) return true;
    return Number(est) / 1_000_000 <= remainingUsd;
  });

  const excluded = beforeFilter.filter((m) => !modelsToTry.includes(m));

  const isComplexOrAgenticFilter =
    hasTools ||
    routingDecision?.tier === "COMPLEX" ||
    routingDecision?.tier === "REASONING" ||
    routingDecision === undefined;

  const filteredToFreeOnly =
    modelsToTry.length > 0 && modelsToTry.every((m) => FREE_MODELS.has(m));

  if (isComplexOrAgenticFilter && filteredToFreeOnly) {
    const budgetSummary = `$${Math.max(0, remainingUsd).toFixed(4)} remaining (limit: $${limitUsd})`;
    return {
      outcome: "block_complex_free_only",
      budgetSummary,
      errPayload: {
        error: {
          message: `OmbRouter budget exhausted: remaining budget (${budgetSummary}) cannot support a complex/tool request. Increase maxCostPerRun to continue.`,
          type: "cost_cap_exceeded",
          code: "budget_exhausted",
        },
      },
    };
  }

  if (excluded.length > 0) {
    const budgetSummary =
      remainingUsd > 0
        ? `$${remainingUsd.toFixed(4)} remaining`
        : `budget exhausted ($${runCostUsd.toFixed(4)}/$${limitUsd})`;
    console.log(
      `[OmbRouter] Budget downgrade (${budgetSummary}): excluded ${excluded.join(", ")}`,
    );

    const fromModel = excluded[0];
    const usingFree = modelsToTry.length === 1 && FREE_MODELS.has(modelsToTry[0]);
    const budgetDowngradeNotice = usingFree
      ? `> **⚠️ Budget cap reached** ($${runCostUsd.toFixed(4)}/$${limitUsd}) — downgraded to free model. Quality may be reduced. Increase \`maxCostPerRun\` to continue with ${fromModel}.\n\n`
      : `> **⚠️ Budget low** ($${remainingUsd > 0 ? remainingUsd.toFixed(4) : "0.0000"} remaining) — using ${modelsToTry[0] ?? FREE_MODEL} instead of ${fromModel}.\n\n`;

    return {
      outcome: "continue",
      modelsToTry,
      excluded,
      budgetDowngradeNotice,
      budgetDowngradeHeaderMode: "downgraded",
    };
  }

  return { outcome: "continue", modelsToTry, excluded: [] };
}
