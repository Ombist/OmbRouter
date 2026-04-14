import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProxyOptions } from "../../proxy.js";
import type { RouterOptions, RoutingDecision } from "../../router/index.js";
import type { SessionJournal } from "../../journal.js";
import type { SessionStore } from "../../session.js";
import type { PayFetchFn } from "../chat-request-context.js";
import { getSessionId, deriveSessionId } from "../../session.js";
import { filterOpenClawInternalTools } from "./openclaw-internal-tools.js";
import { tryHandleCompletionSlashCommands } from "./completion-commands.js";
import {
  applyChatCompletionRoutingProfile,
  type CompletionRoutingMutable,
} from "./completion-routing.js";
import { toUpstreamModelId } from "./upstream-message-prep.js";
import type { RequestTraceLogger } from "./request-trace.js";

type PrepareCtx = {
  apiBase: string;
  payFetch: PayFetchFn;
  routerOpts: RouterOptions;
  sessionStore: SessionStore;
};

export type ChatCompletionPreparationContinue = {
  handled: false;
  body: Buffer;
  isStreaming: boolean;
  modelId: string;
  maxTokens: number;
  hasTools: boolean;
  hasVision: boolean;
  routingProfile: "eco" | "auto" | "premium" | null;
  routingDecision: RoutingDecision | undefined;
  effectiveSessionId: string | undefined;
};

export type ChatCompletionPreparationResult =
  | { handled: true }
  | ChatCompletionPreparationContinue;

/**
 * Parse body, journal, slash commands, routing profile / session / three-strike; may rebuild body.
 */
export async function runChatCompletionPreparationPhase(input: {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  sessionJournal: SessionJournal;
  ctx: PrepareCtx;
  options: ProxyOptions;
  log: RequestTraceLogger;
}): Promise<ChatCompletionPreparationResult> {
  const { req, res, sessionJournal, ctx, options, log } = input;
  let body = input.body;

  const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
  let isStreaming = parsed.stream === true;
  let modelId = (parsed.model as string) || "";
  let maxTokens = (parsed.max_tokens as number) || 4096;
  let bodyModified = false;

  const sessionId = getSessionId(req.headers as Record<string, string | string[] | undefined>);
  let effectiveSessionId: string | undefined = sessionId;

  const parsedMessages = Array.isArray(parsed.messages)
    ? (parsed.messages as Array<{ role: string; content: unknown }>)
    : [];
  const lastUserMsg = [...parsedMessages].reverse().find((m) => m.role === "user");

  let hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;

  if (hasTools && parsed.tools) {
    const removed = filterOpenClawInternalTools(parsed);
    if (removed > 0) {
      bodyModified = true;
      hasTools = Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0;
    }
  }

  const rawLastContent = lastUserMsg?.content;
  const lastContent =
    typeof rawLastContent === "string"
      ? rawLastContent
      : Array.isArray(rawLastContent)
        ? (rawLastContent as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(" ")
        : "";

  if (sessionId && parsedMessages.length > 0) {
    const messages = parsedMessages;

    if (sessionJournal.needsContext(lastContent)) {
      const journalText = sessionJournal.format(sessionId);
      if (journalText) {
        const sysIdx = messages.findIndex((m) => m.role === "system");
        if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
          messages[sysIdx] = {
            ...messages[sysIdx],
            content: journalText + "\n\n" + messages[sysIdx].content,
          };
        } else {
          messages.unshift({ role: "system", content: journalText });
        }
        parsed.messages = messages;
        bodyModified = true;
        log.log(
          `Injected session journal (${journalText.length} chars) for session ${sessionId.slice(0, 8)}...`,
        );
      }
    }
  }

  if (
    await tryHandleCompletionSlashCommands({
      res,
      ctx,
      parsed,
      lastContent,
      isStreaming,
      maxTokens,
      sessionId,
    })
  ) {
    return { handled: true };
  }

  let routingProfile: "eco" | "auto" | "premium" | null = null;
  let hasVision = false;
  let routingDecision: RoutingDecision | undefined;

  const routingMutable: CompletionRoutingMutable = {
    bodyModified,
    modelId,
    routingProfile,
    hasTools,
    hasVision,
    routingDecision,
    effectiveSessionId,
  };
  applyChatCompletionRoutingProfile({
    req,
    parsed,
    parsedMessages,
    lastUserMsg,
    mutable: routingMutable,
    routerOpts: ctx.routerOpts,
    options,
    sessionStore: ctx.sessionStore,
    maxTokens,
  });
  bodyModified = routingMutable.bodyModified;
  modelId = routingMutable.modelId;
  routingProfile = routingMutable.routingProfile;
  hasTools = routingMutable.hasTools;
  hasVision = routingMutable.hasVision;
  routingDecision = routingMutable.routingDecision;
  effectiveSessionId = routingMutable.effectiveSessionId;

  if (!effectiveSessionId && parsedMessages.length > 0) {
    effectiveSessionId = deriveSessionId(parsedMessages);
  }

  if (bodyModified) {
    if (parsed.model && typeof parsed.model === "string") {
      parsed.model = toUpstreamModelId(parsed.model);
    }
    body = Buffer.from(JSON.stringify(parsed));
  }

  return {
    handled: false,
    body,
    isStreaming,
    modelId,
    maxTokens,
    hasTools,
    hasVision,
    routingProfile,
    routingDecision,
    effectiveSessionId,
  };
}
