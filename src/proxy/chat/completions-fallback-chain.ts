import type { RoutingDecision } from "../../router/index.js";
import type { RouterOptions } from "../../router/index.js";
import type { SessionStore } from "../../session.js";
import type { ProxyOptions } from "../../proxy.js";
import {
  getFallbackChain,
  getFallbackChainFiltered,
  filterByToolCalling,
  filterByVision,
  filterByExcludeList,
} from "../../router/index.js";
import {
  getModelContextWindow,
  supportsToolCalling,
  supportsVision,
} from "../../models.js";
import { loadExcludeList } from "../../exclude-models.js";
import { FREE_MODEL, pickFreeModel } from "./free-models.js";
import { prioritizeNonRateLimited } from "./fallback-state.js";
import { MAX_FALLBACK_ATTEMPTS } from "./constants.js";
import type { EstimateAmountFn } from "../estimate-amount.js";
import { applyGracefulBudgetModelFilter } from "./budget.js";
import type { RequestTraceLogger } from "./request-trace.js";

export type BuildModelsToTryResult =
  | {
      kind: "blocked";
      /** JSON string of error body (before request_id injection). */
      errPayloadJson: string;
    }
  | {
      kind: "ok";
      modelsToTry: string[];
      budgetDowngradeNotice?: string;
      budgetDowngradeHeaderMode?: "downgraded";
    };

/**
 * Build ordered model list (routing tier, filters, free tail) and apply graceful budget filter.
 */
export function buildModelsToTryWithGracefulBudget(input: {
  body: Buffer;
  modelId: string;
  maxTokens: number;
  hasTools: boolean;
  hasVision: boolean;
  isFreeModel: boolean;
  routingDecision: RoutingDecision | undefined;
  effectiveSessionId: string | undefined;
  routerOpts: RouterOptions;
  sessionStore: SessionStore;
  options: ProxyOptions;
  log: RequestTraceLogger;
  estimateAmount: EstimateAmountFn;
}): BuildModelsToTryResult {
  const {
    body,
    modelId,
    maxTokens,
    hasTools,
    hasVision,
    isFreeModel,
    routingDecision,
    effectiveSessionId,
    routerOpts,
    sessionStore,
    options,
    log,
    estimateAmount,
  } = input;

  let modelsToTry: string[];
  const excludeList = options.excludeModels ?? loadExcludeList();

  if (isFreeModel && routingDecision && !options.skipBalanceCheck) {
    const freeFallback = pickFreeModel(excludeList) ?? FREE_MODEL;
    modelsToTry = [freeFallback];
    log.log(`Wallet empty — skipping routing chain, using free model: ${freeFallback}`);
  } else if (routingDecision) {
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const estimatedTotalTokens = estimatedInputTokens + maxTokens;

    const tierConfigs = routingDecision.tierConfigs ?? routerOpts.config.tiers;

    const fullChain = getFallbackChain(routingDecision.tier, tierConfigs);
    const contextFiltered = getFallbackChainFiltered(
      routingDecision.tier,
      tierConfigs,
      estimatedTotalTokens,
      getModelContextWindow,
    );

    const contextExcluded = fullChain.filter((m) => !contextFiltered.includes(m));
    if (contextExcluded.length > 0) {
      log.log(
        `Context filter (~${estimatedTotalTokens} tokens): excluded ${contextExcluded.join(", ")}`,
      );
    }

    const excludeFiltered = filterByExcludeList(contextFiltered, excludeList);
    const excludeExcluded = contextFiltered.filter((m) => !excludeFiltered.includes(m));
    if (excludeExcluded.length > 0) {
      log.log(`Exclude filter: excluded ${excludeExcluded.join(", ")} (user preference)`);
    }

    let toolFiltered = filterByToolCalling(excludeFiltered, hasTools, supportsToolCalling);
    const toolExcluded = excludeFiltered.filter((m) => !toolFiltered.includes(m));
    if (toolExcluded.length > 0) {
      log.log(
        `Tool-calling filter: excluded ${toolExcluded.join(", ")} (no structured function call support)`,
      );
    }

    const TOOL_NONCOMPLIANT_MODELS = [
      "google/gemini-2.5-flash-lite",
      "google/gemini-3-pro-preview",
      "google/gemini-3.1-pro",
    ];
    if (hasTools && toolFiltered.length > 1) {
      const compliant = toolFiltered.filter((m) => !TOOL_NONCOMPLIANT_MODELS.includes(m));
      if (compliant.length > 0 && compliant.length < toolFiltered.length) {
        const dropped = toolFiltered.filter((m) => TOOL_NONCOMPLIANT_MODELS.includes(m));
        log.log(
          `Tool-compliance filter: excluded ${dropped.join(", ")} (unreliable tool schema handling)`,
        );
        toolFiltered = compliant;
      }
    }

    const visionFiltered = filterByVision(toolFiltered, hasVision, supportsVision);
    const visionExcluded = toolFiltered.filter((m) => !visionFiltered.includes(m));
    if (visionExcluded.length > 0) {
      log.log(`Vision filter: excluded ${visionExcluded.join(", ")} (no vision support)`);
    }

    modelsToTry = visionFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);

    modelsToTry = prioritizeNonRateLimited(modelsToTry);
  } else {
    modelsToTry = modelId ? [modelId] : [];
  }

  if (!hasTools) {
    const freeFallback = pickFreeModel(excludeList);
    if (freeFallback && !modelsToTry.includes(freeFallback)) {
      modelsToTry.push(freeFallback);
    }
  }

  const skipGracefulBudget = isFreeModel && !options.quotaIncludeFreeInUsdCap;
  if (
    options.maxCostPerRunUsd &&
    effectiveSessionId &&
    !skipGracefulBudget &&
    (options.maxCostPerRunMode ?? "graceful") === "graceful"
  ) {
    const runCostUsd = sessionStore.getSessionCostUsd(effectiveSessionId);
    const bf = applyGracefulBudgetModelFilter({
      modelsToTry,
      maxCostPerRunUsd: options.maxCostPerRunUsd,
      effectiveSessionId,
      isFreeModel,
      quotaIncludeFreeInUsdCap: options.quotaIncludeFreeInUsdCap,
      maxCostPerRunMode: options.maxCostPerRunMode,
      runCostUsd,
      hasTools,
      routingDecision,
      bodyLength: body.length,
      maxTokens,
      estimateAmount,
      limitUsd: options.maxCostPerRunUsd,
    });

    if (bf.outcome === "block_complex_free_only") {
      log.log(
        `Budget filter left only free model for complex/agentic session — blocking (${bf.budgetSummary})`,
      );
      return { kind: "blocked", errPayloadJson: JSON.stringify(bf.errPayload) };
    }

    modelsToTry = bf.modelsToTry;
    return {
      kind: "ok",
      modelsToTry,
      budgetDowngradeNotice: bf.budgetDowngradeNotice,
      budgetDowngradeHeaderMode: bf.budgetDowngradeHeaderMode,
    };
  }

  return { kind: "ok", modelsToTry };
}
