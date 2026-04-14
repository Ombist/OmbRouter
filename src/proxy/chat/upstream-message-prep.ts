/**
 * Map free/xxx model IDs to nvidia/xxx for upstream BlockRun API.
 */
export function toUpstreamModelId(modelId: string): string {
  if (modelId.startsWith("free/")) {
    return "nvidia/" + modelId.slice("free/".length);
  }
  return modelId;
}

export const MAX_MESSAGES = 200;

export type ChatMessage = { role: string; content: string | unknown };

const VALID_ROLES = new Set(["system", "user", "assistant", "tool", "function"]);

const ROLE_MAPPINGS: Record<string, string> = {
  developer: "system",
  model: "assistant",
};

const VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(id: string | undefined): string | undefined {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

type MessageWithTools = ChatMessage & {
  tool_calls?: Array<{ id?: string; type?: string; function?: unknown }>;
  tool_call_id?: string;
};

type ContentBlock = {
  type?: string;
  id?: string;
  tool_use_id?: string;
  [key: string]: unknown;
};

export function sanitizeToolIds(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg as MessageWithTools;
    let msgChanged = false;
    let newMsg = { ...msg } as MessageWithTools;

    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const sid = sanitizeToolId(tc.id);
          if (sid !== tc.id) {
            msgChanged = true;
            return { ...tc, id: sid };
          }
        }
        return tc;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, tool_calls: newToolCalls };
      }
    }

    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const sid = sanitizeToolId(typedMsg.tool_call_id);
      if (sid !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: sid };
      }
    }

    if (Array.isArray(typedMsg.content)) {
      const newContent = (typedMsg.content as ContentBlock[]).map((block) => {
        if (!block || typeof block !== "object") return block;

        let blockChanged = false;
        let newBlock = { ...block };

        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const sid = sanitizeToolId(block.id);
          if (sid !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: sid };
          }
        }

        if (
          block.type === "tool_result" &&
          block.tool_use_id &&
          typeof block.tool_use_id === "string"
        ) {
          const sid = sanitizeToolId(block.tool_use_id);
          if (sid !== block.tool_use_id) {
            blockChanged = true;
            newBlock = { ...newBlock, tool_use_id: sid };
          }
        }

        if (blockChanged) {
          msgChanged = true;
          return newBlock;
        }
        return block;
      });

      if (msgChanged) {
        newMsg = { ...newMsg, content: newContent };
      }
    }

    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });

  return hasChanges ? sanitized : messages;
}

export function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;

    const mappedRole = ROLE_MAPPINGS[msg.role];
    if (mappedRole) {
      hasChanges = true;
      return { ...msg, role: mappedRole };
    }

    hasChanges = true;
    return { ...msg, role: "user" };
  });

  return hasChanges ? normalized : messages;
}

export function normalizeMessagesForGoogle(messages: ChatMessage[]): ChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }

  if (firstNonSystemIdx === -1) return messages;

  const firstRole = messages[firstNonSystemIdx].role;

  if (firstRole === "user") return messages;

  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "(continuing conversation)",
    });
    return normalized;
  }

  return messages;
}

export function isGoogleModel(modelId: string): boolean {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}

export type TruncationResult<T> = {
  messages: T[];
  wasTruncated: boolean;
  originalCount: number;
  truncatedCount: number;
};

export function truncateMessages<T extends { role: string }>(messages: T[]): TruncationResult<T> {
  if (!messages || messages.length <= MAX_MESSAGES) {
    return {
      messages,
      wasTruncated: false,
      originalCount: messages?.length ?? 0,
      truncatedCount: messages?.length ?? 0,
    };
  }

  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversationMsgs = messages.filter((m) => m.role !== "system");

  const maxConversation = MAX_MESSAGES - systemMsgs.length;
  const truncatedConversation = conversationMsgs.slice(-maxConversation);

  const result = [...systemMsgs, ...truncatedConversation];

  console.log(
    `[OmbRouter] Truncated messages: ${messages.length} → ${result.length} (kept ${systemMsgs.length} system + ${truncatedConversation.length} recent)`,
  );

  return {
    messages: result,
    wasTruncated: true,
    originalCount: messages.length,
    truncatedCount: result.length,
  };
}
