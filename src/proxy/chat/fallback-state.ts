import type { ErrorCategory } from "../provider-errors.js";

/** Per-model error category counts (in-memory, resets on restart). */
export type ProviderErrorCounts = {
  auth_failure: number;
  quota_exceeded: number;
  rate_limited: number;
  overloaded: number;
  server_error: number;
  payment_error: number;
  config_error: number;
};

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const OVERLOAD_COOLDOWN_MS = 15_000;

const rateLimitedModels = new Map<string, number>();
const overloadedModels = new Map<string, number>();

/** Shared with /stats — same Map instance as auxiliary routes. */
export const perProviderErrors = new Map<string, ProviderErrorCounts>();

export function recordProviderError(modelId: string, category: ErrorCategory): void {
  if (!perProviderErrors.has(modelId)) {
    perProviderErrors.set(modelId, {
      auth_failure: 0,
      quota_exceeded: 0,
      rate_limited: 0,
      overloaded: 0,
      server_error: 0,
      payment_error: 0,
      config_error: 0,
    });
  }
  perProviderErrors.get(modelId)![category]++;
}

function isRateLimited(modelId: string): boolean {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  const elapsed = Date.now() - hitTime;
  if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}

export function markRateLimited(modelId: string): void {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[OmbRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}

export function markOverloaded(modelId: string): void {
  overloadedModels.set(modelId, Date.now());
  console.log(`[OmbRouter] Model ${modelId} overloaded, will deprioritize for 15s`);
}

function isOverloaded(modelId: string): boolean {
  const hitTime = overloadedModels.get(modelId);
  if (!hitTime) return false;
  if (Date.now() - hitTime >= OVERLOAD_COOLDOWN_MS) {
    overloadedModels.delete(modelId);
    return false;
  }
  return true;
}

export function prioritizeNonRateLimited(models: string[]): string[] {
  const available: string[] = [];
  const degraded: string[] = [];
  for (const model of models) {
    if (isRateLimited(model) || isOverloaded(model)) degraded.push(model);
    else available.push(model);
  }
  return [...available, ...degraded];
}
