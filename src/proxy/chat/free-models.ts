/** Virtual routing profile models */
export const AUTO_MODEL = "blockrun/auto";

export const ROUTING_PROFILES = new Set([
  "blockrun/eco",
  "eco",
  "blockrun/auto",
  "auto",
  "blockrun/premium",
  "premium",
]);

export const FREE_MODELS = new Set([
  "free/gpt-oss-120b",
  "free/gpt-oss-20b",
  "free/nemotron-ultra-253b",
  "free/nemotron-3-super-120b",
  "free/nemotron-super-49b",
  "free/deepseek-v3.2",
  "free/mistral-large-3-675b",
  "free/qwen3-coder-480b",
  "free/devstral-2-123b",
  "free/glm-4.7",
  "free/llama-4-maverick",
]);

export function pickFreeModel(excludeList?: Set<string>): string | undefined {
  for (const m of FREE_MODELS) {
    if (!excludeList?.has(m)) return m;
  }
  return undefined;
}

export const FREE_MODEL = "free/gpt-oss-120b";
