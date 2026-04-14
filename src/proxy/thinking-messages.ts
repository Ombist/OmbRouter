import type { ChatMessage } from "./chat/upstream-message-prep.js";

export type ExtendedChatMessage = ChatMessage & {
  tool_calls?: unknown[];
  reasoning_content?: unknown;
};

export function normalizeMessagesForThinking(
  messages: ExtendedChatMessage[],
): ExtendedChatMessage[] {
  if (!messages || messages.length === 0) return messages;

  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (msg.role !== "assistant" || msg.reasoning_content !== undefined) {
      return msg;
    }

    hasChanges = true;
    return { ...msg, reasoning_content: "" };
  });

  return hasChanges ? normalized : messages;
}
