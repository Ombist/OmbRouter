/**
 * Chat completions orchestration: proxyRequest and related routing / budget / fallback flow.
 */
import { type IncomingMessage, type ServerResponse } from "node:http";
import { readBodyWithTimeout } from "../read-body.js";
import type { ProxyRequestContext } from "../chat-request-context.js";
import { canWrite, safeWrite } from "../response-write.js";
import { BALANCE_CHECK_BUFFER, HEARTBEAT_INTERVAL_MS } from "./constants.js";
import {
  calculateModelCost,
  type RouterOptions,
  type RoutingDecision,
} from "../../router/index.js";
import { loadExcludeList } from "../../exclude-models.js";
import { getSessionId } from "../../session.js";
import { USER_AGENT } from "../../version.js";
import { FREE_MODELS, FREE_MODEL, pickFreeModel } from "./free-models.js";
import { toUpstreamModelId } from "./upstream-message-prep.js";
import { CONTEXT_LIMIT_KB, DEFAULT_REQUEST_TIMEOUT_MS } from "./constants.js";
import { writeChatCompletionStreamFromUpstreamJson } from "./stream-response.js";
import { writeNonStreamChatCompletionFromUpstream } from "./non-stream-response.js";
import { evaluateStrictCostCap, evaluateGracefulBudgetPrecheck } from "./budget.js";
import { runUpstreamFallbackLoop } from "./fallback-loop.js";
import { respondToAllUpstreamModelsFailed } from "./failure-response.js";
import { logCompletionsUsageAfterSuccess } from "./completions-usage-log.js";
import { runChatCompletionPreparationPhase } from "./completions-prepare-chat.js";
import { buildModelsToTryWithGracefulBudget } from "./completions-fallback-chain.js";
import { maybeCompressChatCompletionBody } from "./completions-compression.js";
import { runCompletionCacheAndDedupPhase } from "./completions-cache-dedup.js";
import {
  resolveRequestTrace,
  attachRequestIdToErrorPayload,
  attachRequestIdToErrorJsonString,
  traceResponseHeaders,
  mergeOutgoingHeaders,
  type ResolvedRequestTrace,
} from "./request-trace.js";

function writeJsonErrorWithTrace(
  res: ServerResponse,
  trace: ResolvedRequestTrace,
  status: number,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const out = trace.includeRequestIdInErrorBody
    ? attachRequestIdToErrorPayload(payload, trace.requestId)
    : payload;
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...traceResponseHeaders(trace),
    ...extraHeaders,
  });
  res.end(JSON.stringify(out));
}

/**
 * Proxy a single request through x402 payment flow to BlockRun API.
 *
 * Optimizations applied in order:
 *   1. Dedup check — if same request body seen within 30s, replay cached response
 *   2. Streaming heartbeat — for stream:true, send 200 + heartbeats immediately
 *   3. Smart routing — when model is "blockrun/auto", pick cheapest capable model
 *   4. Fallback chain — on provider errors, try next model in tier's fallback list
 */
export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyRequestContext,
): Promise<void> {
  const {
    apiBase,
    payFetch,
    options,
    routerOpts,
    deduplicator,
    balanceMonitor,
    sessionStore,
    responseCache,
    sessionJournal,
    upstreamMode,
    estimateAmount,
  } = ctx;
  const startTime = Date.now();
  const trace = resolveRequestTrace(req, options);

  // Build upstream URL: /v1/chat/completions → https://blockrun.ai/api/v1/chat/completions
  const upstreamUrl = `${apiBase}${req.url}`;

  // Collect request body
  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);

  // Track original context size for response headers
  const originalContextSizeKB = Math.ceil(body.length / 1024);

  // Routing debug on by default; disable with x-ombrouter-debug: false
  const debugMode = req.headers["x-ombrouter-debug"] !== "false";

  // --- Smart routing ---
  let routingDecision: RoutingDecision | undefined;
  let hasTools = false; // true when request includes a tools schema
  let hasVision = false; // true when request includes image_url content parts
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile: "eco" | "auto" | "premium" | null = null;
  let balanceFallbackNotice: string | undefined;
  let budgetDowngradeNotice: string | undefined;
  let budgetDowngradeHeaderMode: "downgraded" | undefined;
  let accumulatedContent = ""; // For session journal event extraction
  let responseInputTokens: number | undefined;
  let responseOutputTokens: number | undefined;
  let requestHadError = false; // Set to true when all models fail → used in logUsage
  const isChatCompletion = req.url?.includes("/chat/completions");

  // Extract session ID early for journal operations (header-only at this point)
  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  // Full session ID (header + content-derived) — populated once messages are parsed
  let effectiveSessionId: string | undefined = sessionId;

  if (isChatCompletion && body.length > 0) {
    try {
      const prep = await runChatCompletionPreparationPhase({
        req,
        res,
        body,
        sessionJournal,
        ctx: { apiBase, payFetch, routerOpts, sessionStore },
        options,
        log: trace.logger,
      });
      if (prep.handled) {
        return;
      }
      body = Buffer.from(prep.body);
      isStreaming = prep.isStreaming;
      modelId = prep.modelId;
      maxTokens = prep.maxTokens;
      hasTools = prep.hasTools;
      hasVision = prep.hasVision;
      routingProfile = prep.routingProfile;
      routingDecision = prep.routingDecision;
      effectiveSessionId = prep.effectiveSessionId;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      trace.logger.error(`Routing error: ${errorMsg}`);
      trace.logger.error(`Need help? Run: ombrouter doctor (or: node dist/cli.js doctor)`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }

  body = Buffer.from(
    await maybeCompressChatCompletionBody({
      body,
      autoCompress: options.autoCompressRequests ?? true,
      compressionThresholdKB: options.compressionThresholdKB ?? 180,
      log: trace.logger,
    }),
  );

  const cacheDedup = await runCompletionCacheAndDedupPhase({
    req,
    res,
    body,
    responseCache,
    deduplicator,
    trace,
  });
  if (cacheDedup.outcome === "responded") {
    return;
  }
  const { cacheKey, dedupKey } = cacheDedup;

  const tokenCap = options.maxTokensPerSession;
  if (isChatCompletion && tokenCap !== undefined && effectiveSessionId) {
    const used = sessionStore.getSessionTokensTotal(effectiveSessionId);
    const estIn = Math.ceil(body.length / 4);
    if (used + estIn + maxTokens > tokenCap) {
      writeJsonErrorWithTrace(
        res,
        trace,
        429,
        {
          error: {
            message: `OmbRouter token quota exceeded: session has used ${used} tokens (limit ${tokenCap} total input+output).`,
            type: "token_cap_exceeded",
            code: "token_cap_exceeded",
          },
        },
        { "X-OmbRouter-Token-Cap-Exceeded": "1" },
      );
      deduplicator.removeInflight(dedupKey);
      return;
    }
  }

  // --- Pre-request balance check ---
  // Estimate cost and check if wallet has sufficient balance
  // Skip if skipBalanceCheck is set (for testing) or if using free model
  let estimatedCostMicros: bigint | undefined;
  // Use `let` so the balance-fallback path can update this when modelId is switched to a free model.
  let isFreeModel = FREE_MODELS.has(modelId ?? "");

  if (
    upstreamMode === "x402" &&
    modelId &&
    !options.skipBalanceCheck &&
    !isFreeModel
  ) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);

      // Apply extra buffer for balance check to prevent x402 failures after streaming starts.
      // This is aggressive to avoid triggering OpenClaw's 5-24 hour billing cooldown.
      const bufferedCostMicros =
        (estimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100))) / 100n;

      // Check balance before proceeding (using buffered amount)
      // Wrap in try/catch: Solana RPC failures (timeouts, rate limits) should
      // not silently downgrade the request — pass through optimistically instead.
      let sufficiency: Awaited<ReturnType<typeof balanceMonitor.checkSufficient>> | null = null;
      try {
        sufficiency = await balanceMonitor.checkSufficient(bufferedCostMicros);
      } catch (balanceErr) {
        trace.logger.warn(
          `Balance check failed (${balanceErr instanceof Error ? balanceErr.message : String(balanceErr)}) — proceeding optimistically`,
        );
      }

      if (sufficiency && (sufficiency.info.isEmpty || !sufficiency.sufficient)) {
        // Wallet is empty or insufficient — fallback to best available free model
        const freeFallback = pickFreeModel(loadExcludeList()) ?? FREE_MODEL;
        const originalModel = modelId;
        trace.logger.log(
          `Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} (${sufficiency.info.balanceUSD}), falling back to free model: ${freeFallback} (requested: ${originalModel})`,
        );
        modelId = freeFallback;
        isFreeModel = true; // keep in sync — budget logic gates on !isFreeModel
        // Update the body with new model (map free/ → nvidia/ for upstream)
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        parsed.model = toUpstreamModelId(FREE_MODEL);
        body = Buffer.from(JSON.stringify(parsed));

        // Build fund instruction — include wallet address so user knows where to send
        const walletAddr = sufficiency.info.walletAddress;
        const fundHint = walletAddr
          ? ` Send USDC to \`${walletAddr}\`.`
          : " Run `/wallet` to see your address.";

        // Set notice to prepend to response so user knows about the fallback
        balanceFallbackNotice = sufficiency.info.isEmpty
          ? `> **⚠️ Wallet empty** — using free model.${fundHint}\n\n`
          : `> **⚠️ Insufficient balance** (${sufficiency.info.balanceUSD}) — using free model instead of ${originalModel}.${fundHint}\n\n`;

        // Notify about the fallback
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      } else if (sufficiency?.info.isLow) {
        // Balance is low but sufficient — warn and proceed
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress,
        });
      }
    }
  }

  // --- Cost cap check: strict mode hard-stop ---
  // In 'strict' mode, reject if the projected session spend (accumulated + this request's
  // estimate) would exceed the cap. Checking projected cost (not just historical) prevents
  // a single large request from overshooting the cap before it's recorded.
  // In 'graceful' mode (default), the cap is enforced via model downgrade below.
  // Must happen before streaming headers are sent.
  {
    const strictCap = evaluateStrictCostCap({
      maxCostPerRunUsd: options.maxCostPerRunUsd,
      effectiveSessionId,
      isFreeModel,
      quotaIncludeFreeInUsdCap: options.quotaIncludeFreeInUsdCap,
      maxCostPerRunMode: options.maxCostPerRunMode,
      runCostUsd: effectiveSessionId ? sessionStore.getSessionCostUsd(effectiveSessionId) : 0,
      modelId,
      bodyLength: body.length,
      maxTokens,
      estimatedCostMicros,
      estimateAmount,
    });
    if (strictCap) {
      const { projectedCostUsd, runCostUsd, thisReqEstUsd, limit } = strictCap;
      trace.logger.log(
        `Cost cap exceeded for session ${effectiveSessionId!.slice(0, 8)}...: projected $${projectedCostUsd.toFixed(4)} (spent $${runCostUsd.toFixed(4)} + est $${thisReqEstUsd.toFixed(4)}) > $${limit} limit`,
      );
      writeJsonErrorWithTrace(res, trace, 429, {
        error: {
          message: `OmbRouter cost cap exceeded: projected spend $${projectedCostUsd.toFixed(4)} (spent $${runCostUsd.toFixed(4)} + est $${thisReqEstUsd.toFixed(4)}) would exceed limit $${limit}`,
          type: "cost_cap_exceeded",
          code: "cost_cap_exceeded",
        },
      }, { "X-OmbRouter-Cost-Cap-Exceeded": "1" });
      deduplicator.removeInflight(dedupKey);
      return;
    }
  }

  // --- Budget pre-check: block when remaining budget can't cover the request ---
  // Must happen BEFORE streaming headers (429 can't be sent after SSE headers are flushed).
  // Three cases that require a hard block rather than graceful downgrade:
  //   (A) tool/COMPLEX/REASONING routing profile — free model can't substitute
  //   (B) explicit model request (no routing profile) — user chose a specific model,
  //       silently substituting with free model would be deceptive regardless of task type
  // Simple routing profile requests are handled later via graceful downgrade.
  {
    const pre = evaluateGracefulBudgetPrecheck({
      maxCostPerRunUsd: options.maxCostPerRunUsd,
      effectiveSessionId,
      isFreeModel,
      quotaIncludeFreeInUsdCap: options.quotaIncludeFreeInUsdCap,
      maxCostPerRunMode: options.maxCostPerRunMode,
      runCostUsd: effectiveSessionId ? sessionStore.getSessionCostUsd(effectiveSessionId) : 0,
      hasTools,
      routingDecision,
      modelId,
      bodyLength: body.length,
      maxTokens,
      estimateAmount,
    });
    if (pre) {
      const remainingUsd = pre.remainingUsd;
      if (pre.variant === "agentic") {
        trace.logger.log(
          `Budget insufficient for agentic/complex session ${effectiveSessionId!.slice(0, 8)}...: $${remainingUsd.toFixed(4)} remaining — blocking (silent downgrade would corrupt tool/complex responses)`,
        );
        writeJsonErrorWithTrace(
          res,
          trace,
          429,
          {
            error: {
              message: `OmbRouter budget exhausted: $${remainingUsd.toFixed(4)} remaining (limit: $${pre.limit}). Increase maxCostPerRun to continue.`,
              type: "cost_cap_exceeded",
              code: "budget_exhausted",
            },
          },
          {
            "X-OmbRouter-Cost-Cap-Exceeded": "1",
            "X-OmbRouter-Budget-Mode": "blocked",
          },
        );
      } else {
        const mid = pre.explicitModelId ?? modelId;
        trace.logger.log(
          `Budget insufficient for explicit model ${mid} in session ${effectiveSessionId!.slice(0, 8)}...: $${remainingUsd.toFixed(4)} remaining — blocking (user explicitly chose ${mid})`,
        );
        writeJsonErrorWithTrace(
          res,
          trace,
          429,
          {
            error: {
              message: `OmbRouter budget exhausted: $${remainingUsd.toFixed(4)} remaining (limit: $${pre.limit}). Increase maxCostPerRun to continue using ${mid}.`,
              type: "cost_cap_exceeded",
              code: "budget_exhausted",
            },
          },
          {
            "X-OmbRouter-Cost-Cap-Exceeded": "1",
            "X-OmbRouter-Budget-Mode": "blocked",
          },
        );
      }
      deduplicator.removeInflight(dedupKey);
      return;
    }
  }

  // --- Streaming: early header flush + heartbeat ---
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let headersSentEarly = false;

  if (isStreaming) {
    // Send 200 + SSE headers immediately, before x402 flow
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-context-used-kb": String(originalContextSizeKB),
      "x-context-limit-kb": String(CONTEXT_LIMIT_KB),
      ...traceResponseHeaders(trace),
    });
    headersSentEarly = true;

    // First heartbeat immediately
    safeWrite(res, ": heartbeat\n\n");

    // Continue heartbeats every 2s while waiting for upstream
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) {
        safeWrite(res, ": heartbeat\n\n");
      } else {
        // Socket closed, stop heartbeat
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // Forward headers, stripping hop-by-hop and provider-specific headers.
  // OpenClaw v2026.4.2 centralizes provider header handling (native vs proxy),
  // but we strip SDK/provider headers defensively for older clients too.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    // SDK attribution headers (OpenAI x-stainless-*, Anthropic anthropic-*)
    // These are client-side telemetry/protocol headers — not meaningful to BlockRun.
    if (key.startsWith("x-stainless-") || key.startsWith("anthropic-")) continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  headers["user-agent"] = USER_AGENT;
  headers["x-request-id"] = trace.requestId;

  // --- Client disconnect cleanup ---
  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }
    // Remove from in-flight if client disconnected before completion
    if (!completed) {
      deduplicator.removeInflight(dedupKey);
    }
  });

  // --- Request timeout ---
  // Global controller: hard deadline for the entire request (all model attempts combined).
  // Each model attempt gets its own per-model controller (PER_MODEL_TIMEOUT_MS).
  // If a model times out individually, we fall back to the next model instead of failing.
  // Only the global timeout causes an immediate error.
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const globalController = new AbortController();
  const timeoutId = setTimeout(() => globalController.abort(), timeoutMs);

  // Abort in-flight upstream requests when the client disconnects.
  // OpenClaw 2026.4.7+ aborts gateway requests on client disconnect;
  // without this, OmbRouter would leave orphan upstream fetches running.
  const onClientClose = () => {
    if (!globalController.signal.aborted) {
      trace.logger.log(`Client disconnected — aborting upstream request`);
      globalController.abort();
    }
  };
  req.on("close", onClientClose);

  try {
    const built = buildModelsToTryWithGracefulBudget({
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
      log: trace.logger,
      estimateAmount,
    });

    if (built.kind === "blocked") {
      const errJson = trace.includeRequestIdInErrorBody
        ? attachRequestIdToErrorJsonString(built.errPayloadJson, trace.requestId)
        : built.errPayloadJson;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (headersSentEarly) {
        safeWrite(res, `data: ${errJson}\n\ndata: [DONE]\n\n`);
        res.end();
      } else {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "X-OmbRouter-Cost-Cap-Exceeded": "1",
          "X-OmbRouter-Budget-Mode": "blocked",
          ...traceResponseHeaders(trace),
        });
        res.end(errJson);
      }
      deduplicator.removeInflight(dedupKey);
      return;
    }

    const modelsToTry = built.modelsToTry;
    if (built.budgetDowngradeNotice) {
      budgetDowngradeNotice = built.budgetDowngradeNotice;
      budgetDowngradeHeaderMode = built.budgetDowngradeHeaderMode;
    }

    const excludeList = options.excludeModels ?? loadExcludeList();

    // --- Fallback loop: try each model until success ---
    let upstream: Response | undefined;
    let lastError: { body: string; status: number } | undefined;
    let actualModelUsed = modelId;
    let failedAttempts: Array<{ model: string; reason: string; status: number }> = [];

    const fb = await runUpstreamFallbackLoop({
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
      log: trace.logger,
      estimateAmount,
    });
    upstream = fb.upstream;
    lastError = fb.lastError;
    actualModelUsed = fb.actualModelUsed;
    failedAttempts = fb.failedAttempts;

    // Clear timeout and client-close listener — request attempts completed
    clearTimeout(timeoutId);
    req.removeListener("close", onClientClose);

    // Clear heartbeat — real data is about to flow
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // --- Emit routing debug (opt-in; off if x-ombrouter-debug is false) ---
    // For streaming: SSE comment (invisible to most clients, visible in raw stream)
    // For non-streaming: response headers added later
    if (debugMode && headersSentEarly && routingDecision) {
      const debugComment = `: routing-debug profile=${routingProfile ?? "auto"} tier=${routingDecision.tier} model=${actualModelUsed} agentic=${routingDecision.agenticScore?.toFixed(2) ?? "n/a"} confidence=${routingDecision.confidence.toFixed(2)} reasoning=${routingDecision.reasoning}\n\n`;
      safeWrite(res, debugComment);
    }

    // Update routing decision with actual model used (for logging)
    // IMPORTANT: Recalculate cost for the actual model, not the original primary
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const newCosts = calculateModelCost(
        actualModelUsed,
        routerOpts.modelPricing,
        estimatedInputTokens,
        maxTokens,
        routingProfile ?? undefined,
      );
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
        costEstimate: newCosts.costEstimate,
        baselineCost: newCosts.baselineCost,
        savings: newCosts.savings,
      };
      options.onRouted?.(routingDecision);

      // Update session pin to the actual model used — ensures the next request in
      // this conversation starts from the fallback model rather than retrying the
      // primary and falling back again (prevents the "model keeps jumping" issue).
      if (effectiveSessionId) {
        sessionStore.setSession(effectiveSessionId, actualModelUsed, routingDecision.tier);
        trace.logger.log(
          `Session ${effectiveSessionId.slice(0, 8)}... updated pin to fallback: ${actualModelUsed}`,
        );
      }
    }

    // --- Handle case where all models failed ---
    if (!upstream) {
      requestHadError = true;
      respondToAllUpstreamModelsFailed({
        res,
        headersSentEarly,
        failedAttempts,
        lastError,
        originalContextSizeKB,
        contextLimitKb: CONTEXT_LIMIT_KB,
        deduplicator,
        dedupKey,
        routingDecision,
        modelId,
        startTime,
        log: trace.logger,
        requestId: trace.requestId,
        includeRequestIdInErrorBody: trace.includeRequestIdInErrorBody,
        extraResponseHeaders: traceResponseHeaders(trace),
      });
      return;
    }

    // --- Stream / non-stream response (see proxy/chat/stream-response, non-stream-response) ---
    if (headersSentEarly) {
      const streamNotices = {
        balanceFallbackNotice,
        budgetDowngradeNotice,
      };
      const streamResult = await writeChatCompletionStreamFromUpstreamJson({
        res,
        upstream,
        actualModelUsed,
        routingDecision,
        notices: streamNotices,
      });
      balanceFallbackNotice = streamNotices.balanceFallbackNotice;
      budgetDowngradeNotice = streamNotices.budgetDowngradeNotice;
      if (streamResult.responseInputTokens !== undefined)
        responseInputTokens = streamResult.responseInputTokens;
      if (streamResult.responseOutputTokens !== undefined)
        responseOutputTokens = streamResult.responseOutputTokens;
      accumulatedContent = streamResult.accumulatedContent;
      deduplicator.complete(dedupKey, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.concat(streamResult.responseChunks),
        completedAt: Date.now(),
      });
    } else {
      const nonStreamNotices = {
        balanceFallbackNotice,
        budgetDowngradeNotice,
        budgetDowngradeHeaderMode,
      };
      const ns = await writeNonStreamChatCompletionFromUpstream({
        res,
        upstream,
        originalContextSizeKB,
        contextLimitKb: CONTEXT_LIMIT_KB,
        debugMode,
        routingProfile,
        routingDecision,
        actualModelUsed,
        notices: nonStreamNotices,
        deduplicator,
        dedupKey,
        responseCache,
        cacheKey,
        requestBody: body,
      });
      balanceFallbackNotice = nonStreamNotices.balanceFallbackNotice;
      budgetDowngradeNotice = nonStreamNotices.budgetDowngradeNotice;
      budgetDowngradeHeaderMode = nonStreamNotices.budgetDowngradeHeaderMode;
      if (ns.responseInputTokens !== undefined) responseInputTokens = ns.responseInputTokens;
      if (ns.responseOutputTokens !== undefined) responseOutputTokens = ns.responseOutputTokens;
      accumulatedContent = ns.accumulatedContent;
    }

    // --- Session Journal: Extract and record events from response ---
    if (sessionId && accumulatedContent) {
      const events = sessionJournal.extractEvents(accumulatedContent);
      if (events.length > 0) {
        sessionJournal.record(sessionId, events, actualModelUsed);
        trace.logger.log(
          `Recorded ${events.length} events to session journal for session ${sessionId.slice(0, 8)}...`,
        );
      }
    }

    if (tokenCap !== undefined && effectiveSessionId) {
      const inT = responseInputTokens ?? Math.ceil(body.length / 4);
      const outT = responseOutputTokens ?? 0;
      sessionStore.addSessionTokens(effectiveSessionId, inT, outT);
    }

    // --- Optimistic balance deduction after successful response ---
    if (estimatedCostMicros !== undefined) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }

    // Mark request as completed (for client disconnect cleanup)
    completed = true;
  } catch (err) {
    // Clear timeout and client-close listener on error
    clearTimeout(timeoutId);
    req.removeListener("close", onClientClose);

    // Clear heartbeat on error
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
    }

    // Remove in-flight entry so retries aren't blocked
    deduplicator.removeInflight(dedupKey);

    // Invalidate balance cache on payment failure (might be out of date)
    balanceMonitor.invalidate();

    // Convert abort error to more descriptive timeout error
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`, { cause: err });
    }

    throw err;
  }

  logCompletionsUsageAfterSuccess({
    routingDecision,
    modelId,
    bodyLength: body.length,
    maxTokens,
    modelPricing: routerOpts.modelPricing,
    routingProfile,
    startTime,
    requestHadError,
    responseInputTokens,
    responseOutputTokens,
  });
}
