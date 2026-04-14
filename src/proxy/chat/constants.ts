/** SSE heartbeat interval for streaming chat completions (ms). */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Extra buffer for balance check (on top of estimateAmount's 20% buffer).
 * Total effective buffer: 1.2 * 1.5 = 1.8x (80% safety margin).
 */
export const BALANCE_CHECK_BUFFER = 1.5;

/** Server-side context limit (KB) for response headers. */
export const CONTEXT_LIMIT_KB = 5120;

/** 60s per individual model attempt (fallback to next on exceed). */
export const PER_MODEL_TIMEOUT_MS = 60_000;

/** Maximum models to try in fallback chain. */
export const MAX_FALLBACK_ATTEMPTS = 5;

/** Default full request timeout (on-chain tx + LLM). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
