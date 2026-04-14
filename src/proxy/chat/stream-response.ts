import type { ServerResponse } from "node:http";
import type { RoutingDecision } from "../../router/index.js";
import { readBodyWithTimeout } from "../read-body.js";
import { safeWrite } from "../response-write.js";
import { stripThinkingTokens } from "./thinking-strip.js";

export type StreamNoticeState = {
  balanceFallbackNotice?: string;
  budgetDowngradeNotice?: string;
};

/**
 * When SSE headers were sent early: convert upstream JSON completion to OpenAI-style SSE chunks.
 */
export async function writeChatCompletionStreamFromUpstreamJson(input: {
  res: ServerResponse;
  upstream: Response;
  actualModelUsed: string;
  routingDecision: RoutingDecision | undefined;
  notices: StreamNoticeState;
}): Promise<{
  responseChunks: Buffer[];
  responseInputTokens?: number;
  responseOutputTokens?: number;
  accumulatedContent: string;
}> {
  const { res, upstream, actualModelUsed, routingDecision, notices } = input;
  const responseChunks: Buffer[] = [];
  let accumulatedContent = "";
  let responseInputTokens: number | undefined;
  let responseOutputTokens: number | undefined;

  if (upstream.body) {
    const chunks = await readBodyWithTimeout(upstream.body);
    const jsonBody = Buffer.concat(chunks);
    const jsonStr = jsonBody.toString();
    try {
      const rsp = JSON.parse(jsonStr) as {
        id?: string;
        object?: string;
        created?: number;
        model?: string;
        choices?: Array<{
          index?: number;
          message?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          delta?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: unknown;
      };

      if (rsp.usage && typeof rsp.usage === "object") {
        const u = rsp.usage as Record<string, unknown>;
        if (typeof u.prompt_tokens === "number") responseInputTokens = u.prompt_tokens;
        if (typeof u.completion_tokens === "number") responseOutputTokens = u.completion_tokens;
      }

      const baseChunk = {
        id: rsp.id ?? `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: rsp.created ?? Math.floor(Date.now() / 1000),
        model: actualModelUsed || rsp.model || "unknown",
        system_fingerprint: null,
      };

      if (rsp.choices && Array.isArray(rsp.choices)) {
        for (const choice of rsp.choices) {
          const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
          const content = stripThinkingTokens(rawContent);
          const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
          const index = choice.index ?? 0;

          if (content) {
            accumulatedContent += content;
          }

          const roleChunk = {
            ...baseChunk,
            choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }],
          };
          const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
          safeWrite(res, roleData);
          responseChunks.push(Buffer.from(roleData));

          if (notices.balanceFallbackNotice) {
            const noticeChunk = {
              ...baseChunk,
              choices: [
                {
                  index,
                  delta: { content: notices.balanceFallbackNotice },
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            };
            const noticeData = `data: ${JSON.stringify(noticeChunk)}\n\n`;
            safeWrite(res, noticeData);
            responseChunks.push(Buffer.from(noticeData));
            notices.balanceFallbackNotice = undefined;
          }

          if (notices.budgetDowngradeNotice) {
            const noticeChunk = {
              ...baseChunk,
              choices: [
                {
                  index,
                  delta: { content: notices.budgetDowngradeNotice },
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            };
            const noticeData = `data: ${JSON.stringify(noticeChunk)}\n\n`;
            safeWrite(res, noticeData);
            responseChunks.push(Buffer.from(noticeData));
            notices.budgetDowngradeNotice = undefined;
          }

          if (content) {
            const contentChunk = {
              ...baseChunk,
              choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }],
            };
            const contentData = `data: ${JSON.stringify(contentChunk)}\n\n`;
            safeWrite(res, contentData);
            responseChunks.push(Buffer.from(contentData));
          }

          const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
          if (toolCalls && toolCalls.length > 0) {
            const toolCallChunk = {
              ...baseChunk,
              choices: [
                {
                  index,
                  delta: { tool_calls: toolCalls },
                  logprobs: null,
                  finish_reason: null,
                },
              ],
            };
            const toolCallData = `data: ${JSON.stringify(toolCallChunk)}\n\n`;
            safeWrite(res, toolCallData);
            responseChunks.push(Buffer.from(toolCallData));
          }

          const finishChunk = {
            ...baseChunk,
            choices: [
              {
                index,
                delta: {},
                logprobs: null,
                finish_reason:
                  toolCalls && toolCalls.length > 0
                    ? "tool_calls"
                    : (choice.finish_reason ?? "stop"),
              },
            ],
          };
          const finishData = `data: ${JSON.stringify(finishChunk)}\n\n`;
          safeWrite(res, finishData);
          responseChunks.push(Buffer.from(finishData));
        }
      }
    } catch {
      const errPayload = JSON.stringify({
        error: {
          message: `Upstream response could not be parsed: ${jsonStr.slice(0, 200)}`,
          type: "proxy_error",
        },
      });
      const sseData = `data: ${errPayload}\n\n`;
      safeWrite(res, sseData);
      responseChunks.push(Buffer.from(sseData));
    }
  }

  if (routingDecision) {
    const costComment = `: cost=$${routingDecision.costEstimate.toFixed(4)} savings=${(routingDecision.savings * 100).toFixed(0)}% model=${actualModelUsed} tier=${routingDecision.tier}\n\n`;
    safeWrite(res, costComment);
    responseChunks.push(Buffer.from(costComment));
  }

  safeWrite(res, "data: [DONE]\n\n");
  responseChunks.push(Buffer.from("data: [DONE]\n\n"));
  res.end();

  return {
    responseChunks,
    responseInputTokens,
    responseOutputTokens,
    accumulatedContent,
  };
}
