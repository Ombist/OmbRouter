import type { IncomingMessage } from "node:http";
import type { RoutingDecision } from "../../router/index.js";
import { tryModelRequest } from "../chat-try-model.js";
import type { ProxyRequestContext } from "../chat-request-context.js";
import type { ProxyOptions } from "../../proxy.js";
import type { EstimateAmountFn } from "../estimate-amount.js";
import { FREE_MODELS, pickFreeModel } from "./free-models.js";
import { PER_MODEL_TIMEOUT_MS } from "./constants.js";
import {
  recordProviderError,
  markRateLimited,
  markOverloaded,
} from "./fallback-state.js";
import type { SessionStore } from "../../session.js";
import type { RequestTraceLogger } from "./request-trace.js";

export type FallbackLoopResult = {
  upstream?: Response;
  lastError?: { body: string; status: number };
  actualModelUsed: string;
  failedAttempts: Array<{ model: string; reason: string; status: number }>;
};

/**
 * Try each model in `modelsToTry` until success or exhausted. Mutates `modelsToTry`
 * when appending a free model after payment errors.
 */
export async function runUpstreamFallbackLoop(input: {
  modelsToTry: string[];
  upstreamUrl: string;
  req: IncomingMessage;
  headers: Record<string, string>;
  body: Buffer;
  maxTokens: number;
  modelId: string;
  payFetch: ProxyRequestContext["payFetch"];
  balanceMonitor: ProxyRequestContext["balanceMonitor"];
  globalController: AbortController;
  timeoutMs: number;
  excludeList: Set<string>;
  options: ProxyOptions;
  effectiveSessionId: string | undefined;
  sessionStore: SessionStore;
  routingDecision: RoutingDecision | undefined;
  log: RequestTraceLogger;
  estimateAmount: EstimateAmountFn;
}): Promise<FallbackLoopResult> {
  const {
    modelsToTry,
    upstreamUrl,
    req,
    headers,
    body,
    maxTokens,
    modelId,
    payFetch,
    balanceMonitor,
    globalController,
    timeoutMs,
    excludeList,
    options,
    effectiveSessionId,
    sessionStore,
    routingDecision,
    log,
    estimateAmount,
  } = input;

  let upstream: Response | undefined;
  let lastError: { body: string; status: number } | undefined;
  let actualModelUsed = modelId;
  const failedAttempts: Array<{ model: string; reason: string; status: number }> = [];

  for (let i = 0; i < modelsToTry.length; i++) {
    const tryModel = modelsToTry[i];
    const isLastAttempt = i === modelsToTry.length - 1;

    if (globalController.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    log.log(`Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);

    const modelController = new AbortController();
    const modelTimeoutId = setTimeout(() => modelController.abort(), PER_MODEL_TIMEOUT_MS);
    const combinedSignal = AbortSignal.any([globalController.signal, modelController.signal]);

    const result = await tryModelRequest(
      upstreamUrl,
      req.method ?? "POST",
      headers,
      body,
      tryModel,
      maxTokens,
      { payFetch, balanceMonitor },
      combinedSignal,
    );
    clearTimeout(modelTimeoutId);

    if (globalController.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    if (!result.success && modelController.signal.aborted && !isLastAttempt) {
      log.log(
        `Model ${tryModel} timed out after ${PER_MODEL_TIMEOUT_MS}ms, trying fallback`,
      );
      recordProviderError(tryModel, "server_error");
      continue;
    }

    if (result.success && result.response) {
      upstream = result.response;
      actualModelUsed = tryModel;
      log.log(`Success with model: ${tryModel}`);
      if (options.maxCostPerRunUsd && effectiveSessionId) {
        const countTowardCap = !FREE_MODELS.has(tryModel) || options.quotaIncludeFreeInUsdCap;
        if (countTowardCap) {
          const costEst = estimateAmount(tryModel, body.length, maxTokens);
          if (costEst) {
            sessionStore.addSessionCost(effectiveSessionId, BigInt(costEst));
          }
        }
      }
      break;
    }

    lastError = {
      body: result.errorBody || "Unknown error",
      status: result.errorStatus || 500,
    };
    failedAttempts.push({
      model: tryModel,
      reason: result.errorCategory || `HTTP ${result.errorStatus || 500}`,
      status: result.errorStatus || 500,
    });

    const isPaymentErr =
      (options.upstreamMode ?? "x402") !== "apiKey" &&
      /payment.*verification.*failed|payment.*settlement.*failed|insufficient.*funds|transaction_simulation_failed/i.test(
        result.errorBody || "",
      );
    if (isPaymentErr && !FREE_MODELS.has(tryModel) && !isLastAttempt) {
      failedAttempts.push({
        ...failedAttempts[failedAttempts.length - 1],
        reason: "payment_error",
      });
      const freeInChain = modelsToTry.findIndex((m, idx) => idx > i && FREE_MODELS.has(m));
      if (freeInChain > i + 1) {
        log.log(`Payment error — skipping to free model: ${modelsToTry[freeInChain]}`);
        i = freeInChain - 1;
        continue;
      }
      if (freeInChain === -1) {
        const freeFallback = pickFreeModel(excludeList);
        if (freeFallback) {
          modelsToTry.push(freeFallback);
          log.log(`Payment error — appending free model: ${freeFallback}`);
          continue;
        }
      }
    }

    if (result.isProviderError && !isLastAttempt) {
      const isExplicitModelError = !routingDecision;
      const isUnknownExplicitModel =
        isExplicitModelError && /unknown.*model|invalid.*model/i.test(result.errorBody || "");
      if (isUnknownExplicitModel) {
        log.log(
          `Explicit model error from ${tryModel}, not falling back: ${result.errorBody?.slice(0, 100)}`,
        );
        break;
      }

      const errorCat = result.errorCategory;
      if (errorCat) {
        recordProviderError(tryModel, errorCat);
      }

      if (errorCat === "rate_limited") {
        if (!isLastAttempt && !globalController.signal.aborted) {
          log.log(`Rate-limited on ${tryModel}, retrying in 200ms before failover`);
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          if (!globalController.signal.aborted) {
            const retryController = new AbortController();
            const retryTimeoutId = setTimeout(
              () => retryController.abort(),
              PER_MODEL_TIMEOUT_MS,
            );
            const retrySignal = AbortSignal.any([
              globalController.signal,
              retryController.signal,
            ]);
            const retryResult = await tryModelRequest(
              upstreamUrl,
              req.method ?? "POST",
              headers,
              body,
              tryModel,
              maxTokens,
              { payFetch, balanceMonitor },
              retrySignal,
            );
            clearTimeout(retryTimeoutId);
            if (retryResult.success && retryResult.response) {
              upstream = retryResult.response;
              actualModelUsed = tryModel;
              log.log(`Rate-limit retry succeeded for: ${tryModel}`);
              if (options.maxCostPerRunUsd && effectiveSessionId) {
                const countTowardCap = !FREE_MODELS.has(tryModel) || options.quotaIncludeFreeInUsdCap;
                if (countTowardCap) {
                  const costEst = estimateAmount(tryModel, body.length, maxTokens);
                  if (costEst) {
                    sessionStore.addSessionCost(effectiveSessionId, BigInt(costEst));
                  }
                }
              }
              break;
            }
          }
        }
        markRateLimited(tryModel);
      } else if (errorCat === "overloaded") {
        markOverloaded(tryModel);
      } else if (errorCat === "auth_failure" || errorCat === "quota_exceeded") {
        log.log(
          `🔑 ${errorCat === "auth_failure" ? "Auth failure" : "Quota exceeded"} for ${tryModel} — check provider config`,
        );
      }

      log.log(
        `Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`,
      );
      continue;
    }

    if (!result.isProviderError) {
      log.log(
        `Non-provider error from ${tryModel}, not retrying: ${result.errorBody?.slice(0, 100)}`,
      );
    }
    break;
  }

  return { upstream, lastError, actualModelUsed, failedAttempts };
}
