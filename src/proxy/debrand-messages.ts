import type { ChatMessage } from "./chat/upstream-message-prep.js";

export function debrandSystemMessages(
  messages: ChatMessage[],
  resolvedModel: string,
): ChatMessage[] {
  const PROFILE_NAMES = ["auto", "free", "eco", "premium"];
  const profilePattern = new RegExp(`\\bblockrun/(${PROFILE_NAMES.join("|")})\\b`, "gi");
  const prefixPattern = /\bblockrun\/(?=[a-z])/gi;

  let hasChanges = false;
  const result = messages.map((msg) => {
    if (msg.role !== "system" || typeof msg.content !== "string") return msg;

    let content = msg.content;

    const afterProfiles = content.replace(profilePattern, resolvedModel);

    const afterPrefix = afterProfiles.replace(prefixPattern, "");

    if (afterPrefix !== content) {
      hasChanges = true;
      content = afterPrefix;
    }

    return content !== msg.content ? { ...msg, content } : msg;
  });

  return hasChanges ? result : messages;
}
