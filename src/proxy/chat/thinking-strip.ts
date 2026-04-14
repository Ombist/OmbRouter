const KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;
const KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;
const THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\b[^>]*>/gi;
const THINKING_BLOCK_RE =
  /<\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking|antml:thinking)\s*>/gi;

export function stripThinkingTokens(content: string): string {
  if (!content) return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}
