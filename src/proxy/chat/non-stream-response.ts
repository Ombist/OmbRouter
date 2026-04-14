import type { ServerResponse } from "node:http";
import type { RoutingDecision } from "../../router/index.js";
import type { ResponseCache } from "../../response-cache.js";
import type { RequestDeduplicator } from "../../dedup.js";
import { readBodyWithTimeout } from "../read-body.js";
import { safeWrite } from "../response-write.js";
import { stripThinkingTokens } from "./thinking-strip.js";

export type NonStreamNoticeState = {
  balanceFallbackNotice?: string;
  budgetDowngradeNotice?: string;
  budgetDowngradeHeaderMode?: "downgraded";
};

/**
 * Forward non-streaming upstream response: headers, notices, cache hooks.
 */
export async function writeNonStreamChatCompletionFromUpstream(input: {
  res: ServerResponse;
  upstream: Response;
  originalContextSizeKB: number;
  contextLimitKb: number;
  debugMode: boolean;
  routingProfile: "eco" | "auto" | "premium" | null;
  routingDecision: RoutingDecision | undefined;
  actualModelUsed: string;
  notices: NonStreamNoticeState;
  deduplicator: RequestDeduplicator;
  dedupKey: string;
  responseCache: ResponseCache;
  cacheKey: string;
  requestBody: Buffer;
}): Promise<{
  responseChunks: Buffer[];
  responseInputTokens?: number;
  responseOutputTokens?: number;
  accumulatedContent: string;
}> {
  const {
    res,
    upstream,
    originalContextSizeKB,
    contextLimitKb,
    debugMode,
    routingProfile,
    routingDecision,
    actualModelUsed,
    notices,
    deduplicator,
    dedupKey,
    responseCache,
    cacheKey,
    requestBody,
  } = input;

  const responseChunks: Buffer[] = [];
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
    responseHeaders[key] = value;
  });

  responseHeaders["x-context-used-kb"] = String(originalContextSizeKB);
  responseHeaders["x-context-limit-kb"] = String(contextLimitKb);

  if (debugMode && routingDecision) {
    responseHeaders["x-ombrouter-profile"] = routingProfile ?? "auto";
    responseHeaders["x-ombrouter-tier"] = routingDecision.tier;
    responseHeaders["x-ombrouter-model"] = actualModelUsed;
    responseHeaders["x-ombrouter-confidence"] = routingDecision.confidence.toFixed(2);
    responseHeaders["x-ombrouter-reasoning"] = routingDecision.reasoning;
    if (routingDecision.agenticScore !== undefined) {
      responseHeaders["x-ombrouter-agentic-score"] = routingDecision.agenticScore.toFixed(2);
    }
  }

  if (routingDecision) {
    responseHeaders["x-ombrouter-cost"] = routingDecision.costEstimate.toFixed(6);
    responseHeaders["x-ombrouter-savings"] = `${(routingDecision.savings * 100).toFixed(0)}%`;
  }

  const bodyParts: Buffer[] = [];
  if (upstream.body) {
    const chunks = await readBodyWithTimeout(upstream.body);
    for (const chunk of chunks) {
      bodyParts.push(Buffer.from(chunk));
    }
  }

  let responseBody = Buffer.concat(bodyParts);

  if (responseBody.length > 0) {
    try {
      const parsed = JSON.parse(responseBody.toString()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (parsed.choices?.[0]?.message?.content) {
        const stripped = stripThinkingTokens(parsed.choices[0].message.content);
        if (stripped !== parsed.choices[0].message.content) {
          parsed.choices[0].message.content = stripped;
          responseBody = Buffer.from(JSON.stringify(parsed));
        }
      }
    } catch {
      /* not JSON */
    }
  }

  if (notices.balanceFallbackNotice && responseBody.length > 0) {
    try {
      const parsed = JSON.parse(responseBody.toString()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (parsed.choices?.[0]?.message?.content !== undefined) {
        parsed.choices[0].message.content =
          notices.balanceFallbackNotice + parsed.choices[0].message.content;
        responseBody = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* skip */
    }
    notices.balanceFallbackNotice = undefined;
  }

  if (notices.budgetDowngradeNotice && responseBody.length > 0) {
    try {
      const parsed = JSON.parse(responseBody.toString()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      if (parsed.choices?.[0]?.message?.content !== undefined) {
        parsed.choices[0].message.content =
          notices.budgetDowngradeNotice + parsed.choices[0].message.content;
        responseBody = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* skip */
    }
    notices.budgetDowngradeNotice = undefined;
  }

  if (actualModelUsed && responseBody.length > 0) {
    try {
      const parsed = JSON.parse(responseBody.toString()) as { model?: string };
      if (parsed.model !== undefined) {
        parsed.model = actualModelUsed;
        responseBody = Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      /* skip */
    }
  }

  if (notices.budgetDowngradeHeaderMode) {
    responseHeaders["x-ombrouter-budget-downgrade"] = "1";
    responseHeaders["x-ombrouter-budget-mode"] = notices.budgetDowngradeHeaderMode;
    notices.budgetDowngradeHeaderMode = undefined;
  }

  responseHeaders["content-length"] = String(responseBody.length);
  res.writeHead(upstream.status, responseHeaders);
  safeWrite(res, responseBody);
  responseChunks.push(responseBody);
  res.end();

  deduplicator.complete(dedupKey, {
    status: upstream.status,
    headers: responseHeaders,
    body: responseBody,
    completedAt: Date.now(),
  });

  if (upstream.status === 200 && responseCache.shouldCache(requestBody)) {
    responseCache.set(cacheKey, {
      body: responseBody,
      status: upstream.status,
      headers: responseHeaders,
      model: actualModelUsed,
    });
    console.log(
      `[OmbRouter] Cached response for ${actualModelUsed} (${responseBody.length} bytes)`,
    );
  }

  let accumulatedContent = "";
  let responseInputTokens: number | undefined;
  let responseOutputTokens: number | undefined;
  try {
    const rspJson = JSON.parse(responseBody.toString()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, unknown>;
    };
    if (rspJson.choices?.[0]?.message?.content) {
      accumulatedContent = rspJson.choices[0].message.content;
    }
    if (rspJson.usage && typeof rspJson.usage === "object") {
      if (typeof rspJson.usage.prompt_tokens === "number")
        responseInputTokens = rspJson.usage.prompt_tokens;
      if (typeof rspJson.usage.completion_tokens === "number")
        responseOutputTokens = rspJson.usage.completion_tokens;
    }
  } catch {
    /* ignore */
  }

  return {
    responseChunks,
    responseInputTokens,
    responseOutputTokens,
    accumulatedContent,
  };
}
