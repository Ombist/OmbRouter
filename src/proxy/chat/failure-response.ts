import type { ServerResponse } from "node:http";
import type { RoutingDecision } from "../../router/index.js";
import { paymentStore } from "../payment-context.js";
import { safeWrite } from "../response-write.js";
import { transformPaymentError } from "../transform-payment-error.js";
import { logUsage } from "../../logger.js";
import type { RequestDeduplicator } from "../../dedup.js";
import {
  attachRequestIdToErrorJsonString,
  type RequestTraceLogger,
} from "./request-trace.js";

/**
 * When every model in the fallback chain failed: SSE or JSON error + dedup complete + usage log.
 */
export function respondToAllUpstreamModelsFailed(input: {
  res: ServerResponse;
  headersSentEarly: boolean;
  failedAttempts: Array<{ model: string; reason: string; status: number }>;
  lastError?: { body: string; status: number };
  originalContextSizeKB: number;
  contextLimitKb: number;
  deduplicator: RequestDeduplicator;
  dedupKey: string;
  routingDecision: RoutingDecision | undefined;
  modelId: string;
  startTime: number;
  log: RequestTraceLogger;
  requestId: string;
  includeRequestIdInErrorBody: boolean;
  extraResponseHeaders: Record<string, string>;
}): void {
  const {
    res,
    headersSentEarly,
    failedAttempts,
    lastError,
    originalContextSizeKB,
    contextLimitKb,
    deduplicator,
    dedupKey,
    routingDecision,
    modelId,
    startTime,
    log,
    requestId,
    includeRequestIdInErrorBody,
    extraResponseHeaders,
  } = input;

  const attemptSummary =
    failedAttempts.length > 0
      ? failedAttempts.map((a) => `${a.model} (${a.reason})`).join(", ")
      : "unknown";
  const structuredMessage =
    failedAttempts.length > 0
      ? `All ${failedAttempts.length} models failed. Tried: ${attemptSummary}`
      : "All models in fallback chain failed";
  log.log(structuredMessage);
  const rawErrBody = lastError?.body || structuredMessage;
  const errStatus = lastError?.status || 502;

  const transformedErr = transformPaymentError(rawErrBody);

  if (headersSentEarly) {
    let errPayload: string;
    try {
      const parsed = JSON.parse(transformedErr);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        errPayload = JSON.stringify(parsed);
      } else {
        errPayload = JSON.stringify({
          error: { message: rawErrBody, type: "provider_error", status: errStatus },
        });
      }
    } catch {
      errPayload = JSON.stringify({
        error: { message: rawErrBody, type: "provider_error", status: errStatus },
      });
    }
    if (includeRequestIdInErrorBody) {
      errPayload = attachRequestIdToErrorJsonString(errPayload, requestId);
    }
    const errEvent = `data: ${errPayload}\n\n`;
    safeWrite(res, errEvent);
    safeWrite(res, "data: [DONE]\n\n");
    res.end();

    const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
    deduplicator.complete(dedupKey, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: errBuf,
      completedAt: Date.now(),
    });
  } else {
    const bodyOut = includeRequestIdInErrorBody
      ? attachRequestIdToErrorJsonString(transformedErr, requestId)
      : transformedErr;
    res.writeHead(errStatus, {
      "Content-Type": "application/json",
      "x-context-used-kb": String(originalContextSizeKB),
      "x-context-limit-kb": String(contextLimitKb),
      ...extraResponseHeaders,
    });
    res.end(bodyOut);

    deduplicator.complete(dedupKey, {
      status: errStatus,
      headers: { "content-type": "application/json" },
      body: Buffer.from(bodyOut),
      completedAt: Date.now(),
    });
  }

  const errModel = routingDecision?.model ?? modelId;
  if (errModel) {
    const errPayment = paymentStore.getStore()?.amountUsd ?? 0;
    logUsage({
      timestamp: new Date().toISOString(),
      model: errModel,
      tier: routingDecision?.tier ?? "DIRECT",
      cost: errPayment,
      baselineCost: errPayment,
      savings: 0,
      latencyMs: Date.now() - startTime,
      status: "error",
    }).catch(() => {});
  }
}
