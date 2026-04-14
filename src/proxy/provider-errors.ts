/**
 * Semantic error categories from upstream provider responses.
 * Used to distinguish auth failures from rate limits from server errors
 * so each category can be handled independently without cross-contamination.
 */
export type ErrorCategory =
  | "auth_failure" // 401, 403: Wrong key or forbidden — don't retry with same key
  | "quota_exceeded" // 403 with plan/quota body: Plan limit hit
  | "rate_limited" // 429: Actual throttling — 60s cooldown
  | "overloaded" // 529, 503+overload body: Provider capacity — 15s cooldown
  | "server_error" // 5xx general: Transient — fallback immediately
  | "payment_error" // 402: x402 payment or funds issue
  | "config_error"; // 400, 413: Bad request content — skip this model

/**
 * Error patterns that indicate a provider-side issue (not user's fault).
 * These errors should trigger fallback to the next model in the chain.
 */
const PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /model.*not.*available/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
  /request too large/i,
  /request.*size.*exceeds/i,
  /payload too large/i,
  /payment.*verification.*failed/i,
  /model.*not.*allowed/i,
  /unknown.*model/i,
  /reasoning_content.*missing/i, // Thinking model multi-turn: missing reasoning_content → fallback
  /thinking.*reasoning_content/i,
];

/**
 * "Successful" response bodies that are actually provider degradation placeholders.
 * Some upstream providers occasionally return these with HTTP 200.
 */
const DEGRADED_RESPONSE_PATTERNS = [
  /the ai service is temporarily overloaded/i,
  /service is temporarily overloaded/i,
  /please try again in a moment/i,
];

/**
 * Known low-quality loop signatures seen during provider degradation windows.
 */
const DEGRADED_LOOP_PATTERNS = [
  /the boxed is the response\./i,
  /the response is the text\./i,
  /the final answer is the boxed\./i,
];

function extractAssistantContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return undefined;
  const choice = firstChoice as Record<string, unknown>;
  const message = choice.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function hasKnownLoopSignature(text: string): boolean {
  const matchCount = DEGRADED_LOOP_PATTERNS.reduce(
    (count, pattern) => (pattern.test(text) ? count + 1 : count),
    0,
  );
  if (matchCount >= 2) return true;

  // Generic repetitive loop fallback for short repeated lines.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 8) return false;

  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  const maxRepeat = Math.max(...counts.values());
  const uniqueRatio = counts.size / lines.length;
  return maxRepeat >= 3 && uniqueRatio <= 0.45;
}

/**
 * Classify an upstream error response into a semantic category.
 * Returns null if the status+body is not a provider-side issue worth retrying.
 */
export function categorizeError(status: number, body: string): ErrorCategory | null {
  if (status === 401) return "auth_failure";
  if (status === 402) return "payment_error";
  if (status === 403) {
    if (/plan.*limit|quota.*exceeded|subscription|allowance/i.test(body)) return "quota_exceeded";
    return "auth_failure"; // generic 403 = forbidden = likely auth issue
  }
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 503 && /overload|capacity|too.*many.*request/i.test(body)) return "overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 413) {
    // Only fallback on content-size or billing patterns; bare 400 = our bug, don't cycle
    if (PROVIDER_ERROR_PATTERNS.some((p) => p.test(body))) return "config_error";
    return null;
  }
  return null;
}

/**
 * Detect degraded 200-response payloads that should trigger model fallback.
 * Returns a short reason when fallback should happen, otherwise undefined.
 */
export function detectDegradedSuccessResponse(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  // Plain-text placeholder response.
  if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "degraded response: overloaded placeholder";
  }

  // Plain-text looping garbage response.
  if (hasKnownLoopSignature(trimmed)) {
    return "degraded response: repetitive loop output";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Some providers return JSON error payloads with HTTP 200.
    const errorField = parsed.error;
    let errorText = "";
    if (typeof errorField === "string") {
      errorText = errorField;
    } else if (errorField && typeof errorField === "object") {
      const errObj = errorField as Record<string, unknown>;
      errorText = [
        typeof errObj.message === "string" ? errObj.message : "",
        typeof errObj.type === "string" ? errObj.type : "",
        typeof errObj.code === "string" ? errObj.code : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (errorText && PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
      return `degraded response: ${errorText.slice(0, 120)}`;
    }

    // Detect empty-turn responses: model returned 200 but no content and no tool calls.
    // Happens when models like gemini-3.1-flash-lite receive complex agentic requests
    // (e.g. Roo Code tool schemas) and produce zero output instead of refusing.
    const choices = parsed.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0] as Record<string, unknown>;
      const msg = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
      if (msg) {
        const content = msg.content;
        const toolCalls = msg.tool_calls;
        const hasContent = typeof content === "string" && content.trim().length > 0;
        const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
        const finishReason = choice.finish_reason as string | null | undefined;
        if (!hasContent && !hasToolCalls && finishReason === "stop") {
          return "degraded response: empty turn (no content or tool calls)";
        }
      }
    }

    // Successful wrapper with bad assistant content.
    const assistantContent = extractAssistantContent(parsed);
    if (!assistantContent) return undefined;
    if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(assistantContent))) {
      return "degraded response: overloaded assistant content";
    }
    if (hasKnownLoopSignature(assistantContent)) {
      return "degraded response: repetitive assistant loop";
    }
  } catch {
    // Not JSON - handled by plaintext checks above.
  }

  return undefined;
}
