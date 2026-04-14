import { isReasoningModel } from "../models.js";
import type { ProxyRequestContext } from "./chat-request-context.js";
import {
  categorizeError,
  detectDegradedSuccessResponse,
  type ErrorCategory,
} from "./provider-errors.js";
import { readBodyWithTimeout, ERROR_BODY_READ_TIMEOUT_MS } from "./read-body.js";
import {
  toUpstreamModelId,
  sanitizeToolIds,
  normalizeMessageRoles,
  truncateMessages,
  isGoogleModel,
  normalizeMessagesForGoogle,
  type ChatMessage,
} from "./chat/upstream-message-prep.js";
import { debrandSystemMessages } from "./debrand-messages.js";
import { normalizeMessagesForThinking, type ExtendedChatMessage } from "./thinking-messages.js";

export type ModelRequestResult = {
  success: boolean;
  response?: Response;
  errorBody?: string;
  errorStatus?: number;
  isProviderError?: boolean;
  errorCategory?: ErrorCategory;
};

export async function tryModelRequest(
  upstreamUrl: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  modelId: string,
  maxTokens: number,
  ctx: Pick<ProxyRequestContext, "payFetch" | "balanceMonitor">,
  signal: AbortSignal,
): Promise<ModelRequestResult> {
  const { payFetch } = ctx;

  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
    parsed.model = toUpstreamModelId(modelId);

    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages as ChatMessage[]);
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = debrandSystemMessages(parsed.messages as ChatMessage[], modelId);
    }

    if (Array.isArray(parsed.messages)) {
      const truncationResult = truncateMessages(parsed.messages as ChatMessage[]);
      parsed.messages = truncationResult.messages;
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = sanitizeToolIds(parsed.messages as ChatMessage[]);
    }

    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages as ChatMessage[]);
    }

    const hasThinkingEnabled = !!(
      parsed.thinking ||
      parsed.extended_thinking ||
      isReasoningModel(modelId)
    );
    if (hasThinkingEnabled && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages as ExtendedChatMessage[]);
    }

    requestBody = Buffer.from(JSON.stringify(parsed));
  } catch {
    /* use as-is */
  }

  try {
    const response = await payFetch(upstreamUrl, {
      method,
      headers,
      body: requestBody.length > 0 ? new Uint8Array(requestBody) : undefined,
      signal,
    });

    if (response.status !== 200) {
      const errorBodyChunks = await readBodyWithTimeout(response.body, ERROR_BODY_READ_TIMEOUT_MS);
      const errorBody = Buffer.concat(errorBodyChunks).toString();
      const category = categorizeError(response.status, errorBody);

      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: category !== null,
        errorCategory: category ?? undefined,
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("text")) {
      try {
        const clonedChunks = await readBodyWithTimeout(
          response.clone().body,
          ERROR_BODY_READ_TIMEOUT_MS,
        );
        const responseBody = Buffer.concat(clonedChunks).toString();
        const degradedReason = detectDegradedSuccessResponse(responseBody);
        if (degradedReason) {
          return {
            success: false,
            errorBody: degradedReason,
            errorStatus: 503,
            isProviderError: true,
          };
        }
      } catch {
        /* pass through */
      }
    }

    return { success: true, response };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorBody: errorMsg,
      errorStatus: 500,
      isProviderError: true,
    };
  }
}
