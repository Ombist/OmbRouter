import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "../../proxy.js";
import { route, type RouterOptions, type RoutingDecision, type Tier } from "../../router/index.js";
import { resolveModelAlias } from "../../models.js";
import { getSessionId, deriveSessionId, hashRequestContent, type SessionStore } from "../../session.js";
import { ROUTING_PROFILES } from "./free-models.js";

export type CompletionRoutingMutable = {
  bodyModified: boolean;
  modelId: string;
  routingProfile: "eco" | "auto" | "premium" | null;
  hasTools: boolean;
  hasVision: boolean;
  routingDecision: RoutingDecision | undefined;
  effectiveSessionId: string | undefined;
};

/**
 * Normalizes model id, applies routing-profile session pinning, upgrades, three-strike escalation.
 * Mutates `parsed` and fields on `mutable` in place.
 */
export function applyChatCompletionRoutingProfile(input: {
  req: IncomingMessage;
  parsed: Record<string, unknown>;
  parsedMessages: Array<{ role: string; content: unknown }>;
  lastUserMsg: { role: string; content: unknown } | undefined;
  mutable: CompletionRoutingMutable;
  routerOpts: RouterOptions;
  options: ProxyOptions;
  sessionStore: SessionStore;
  maxTokens: number;
}): void {
  const {
    req,
    parsed,
    parsedMessages,
    lastUserMsg,
    mutable,
    routerOpts,
    options,
    sessionStore,
    maxTokens,
  } = input;

  if (parsed.stream === true) {
    parsed.stream = false;
    mutable.bodyModified = true;
  }

  const normalizedModel =
    typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";

  const resolvedModel = resolveModelAlias(normalizedModel);
  const wasAlias = resolvedModel !== normalizedModel;

  const isRoutingProfile =
    ROUTING_PROFILES.has(normalizedModel) || ROUTING_PROFILES.has(resolvedModel);

  if (isRoutingProfile) {
    const profileName = resolvedModel.replace("blockrun/", "");
    mutable.routingProfile = profileName as "eco" | "auto" | "premium";
  }

  console.log(
    `[OmbRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}${mutable.routingProfile ? `, profile: ${mutable.routingProfile}` : ""}`,
  );

  if (!isRoutingProfile) {
    if (parsed.model !== resolvedModel) {
      parsed.model = resolvedModel;
      mutable.bodyModified = true;
    }
    mutable.modelId = resolvedModel;
  }

  if (isRoutingProfile) {
    mutable.effectiveSessionId =
      getSessionId(req.headers as Record<string, string | string[] | undefined>) ??
      deriveSessionId(parsedMessages);
    const existingSession = mutable.effectiveSessionId
      ? sessionStore.getSession(mutable.effectiveSessionId)
      : undefined;

    const rawPrompt = lastUserMsg?.content;
    const prompt =
      typeof rawPrompt === "string"
        ? rawPrompt
        : Array.isArray(rawPrompt)
          ? (rawPrompt as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join(" ")
          : "";
    const systemMsg = parsedMessages.find((m) => m.role === "system");
    const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;

    const tools = parsed.tools as unknown[] | undefined;
    mutable.hasTools = Array.isArray(tools) && tools.length > 0;

    if (mutable.hasTools && tools) {
      console.log(`[OmbRouter] Tools detected (${tools.length}), forcing agentic tiers`);
    }

    mutable.hasVision = parsedMessages.some((m) => {
      if (Array.isArray(m.content)) {
        return (m.content as Array<{ type: string }>).some((p) => p.type === "image_url");
      }
      return false;
    });
    if (mutable.hasVision) {
      console.log(`[OmbRouter] Vision content detected, filtering to vision-capable models`);
    }

    mutable.routingDecision = route(prompt, systemPrompt, maxTokens, {
      ...routerOpts,
      routingProfile: mutable.routingProfile ?? undefined,
      hasTools: mutable.hasTools,
    });

    if (mutable.hasTools && mutable.routingDecision.tier === "SIMPLE") {
      console.log(
        `[OmbRouter] SIMPLE+tools: keeping agentic model ${mutable.routingDecision.model} (tools need reliable function-call support)`,
      );
    }

    if (existingSession) {
      const tierRank: Record<string, number> = {
        SIMPLE: 0,
        MEDIUM: 1,
        COMPLEX: 2,
        REASONING: 3,
      };
      const existingRank = tierRank[existingSession.tier] ?? 0;
      const newRank = tierRank[mutable.routingDecision.tier] ?? 0;

      if (newRank > existingRank) {
        console.log(
          `[OmbRouter] Session ${mutable.effectiveSessionId?.slice(0, 8)}... upgrading: ${existingSession.tier} → ${mutable.routingDecision.tier} (${mutable.routingDecision.model})`,
        );
        parsed.model = mutable.routingDecision.model;
        mutable.modelId = mutable.routingDecision.model;
        mutable.bodyModified = true;
        if (mutable.effectiveSessionId) {
          sessionStore.setSession(
            mutable.effectiveSessionId,
            mutable.routingDecision.model,
            mutable.routingDecision.tier,
          );
        }
      } else if (mutable.routingDecision.tier === "SIMPLE") {
        console.log(
          `[OmbRouter] Session ${mutable.effectiveSessionId?.slice(0, 8)}... SIMPLE follow-up, using cheap model: ${mutable.routingDecision.model} (bypassing pinned ${existingSession.tier})`,
        );
        parsed.model = mutable.routingDecision.model;
        mutable.modelId = mutable.routingDecision.model;
        mutable.bodyModified = true;
        sessionStore.touchSession(mutable.effectiveSessionId!);
      } else {
        console.log(
          `[OmbRouter] Session ${mutable.effectiveSessionId?.slice(0, 8)}... keeping pinned model: ${existingSession.model} (${existingSession.tier} >= ${mutable.routingDecision.tier})`,
        );
        parsed.model = existingSession.model;
        mutable.modelId = existingSession.model;
        mutable.bodyModified = true;
        sessionStore.touchSession(mutable.effectiveSessionId!);
        mutable.routingDecision = {
          ...mutable.routingDecision,
          model: existingSession.model,
          tier: existingSession.tier as Tier,
        };
      }

      const lastAssistantMsg = [...parsedMessages].reverse().find((m) => m.role === "assistant");
      const assistantToolCalls = (
        lastAssistantMsg as { tool_calls?: Array<{ function?: { name?: string } }> }
      )?.tool_calls;
      const toolCallNames = Array.isArray(assistantToolCalls)
        ? assistantToolCalls
            .map((tc) => tc.function?.name)
            .filter((n): n is string => Boolean(n))
        : undefined;
      const contentHash = hashRequestContent(prompt, toolCallNames);
      const shouldEscalate = sessionStore.recordRequestHash(
        mutable.effectiveSessionId!,
        contentHash,
      );

      if (shouldEscalate) {
        const activeTierConfigs = mutable.routingDecision.tierConfigs ?? routerOpts.config.tiers;

        const escalation = sessionStore.escalateSession(
          mutable.effectiveSessionId!,
          activeTierConfigs,
        );
        if (escalation) {
          console.log(
            `[OmbRouter] ⚡ 3-strike escalation: ${existingSession.model} → ${escalation.model} (${existingSession.tier} → ${escalation.tier})`,
          );
          parsed.model = escalation.model;
          mutable.modelId = escalation.model;
          mutable.routingDecision = {
            ...mutable.routingDecision,
            model: escalation.model,
            tier: escalation.tier as Tier,
          };
        }
      }
    } else {
      parsed.model = mutable.routingDecision.model;
      mutable.modelId = mutable.routingDecision.model;
      mutable.bodyModified = true;
      if (mutable.effectiveSessionId) {
        sessionStore.setSession(
          mutable.effectiveSessionId,
          mutable.routingDecision.model,
          mutable.routingDecision.tier,
        );
        console.log(
          `[OmbRouter] Session ${mutable.effectiveSessionId.slice(0, 8)}... pinned to model: ${mutable.routingDecision.model}`,
        );
      }
    }

    options.onRouted?.(mutable.routingDecision);
  }
}
