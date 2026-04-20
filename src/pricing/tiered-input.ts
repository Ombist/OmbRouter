/**
 * Tiered token pricing (USD per 1M tokens per segment).
 *
 * Shared core: cumulative upper bounds per segment; tail uses scalar fallback.
 * Input/output/cache wrappers preserve field names for JSON and BlockRunModel.
 */

/** Internal segment shape (cumulative upper bound per tier). */
export type SegmentPriceTier = {
  maxTokens: number;
  pricePerMillion: number;
};

export type InputPriceTier = {
  /** Cumulative inclusive upper bound of input tokens for this segment (use Infinity for remainder). */
  maxInputTokens: number;
  pricePerMillion: number;
};

export type OutputPriceTier = {
  /** Cumulative upper bound of output (completion) tokens for this segment. */
  maxOutputTokens: number;
  pricePerMillion: number;
};

export type CacheReadPriceTier = {
  maxCacheReadTokens: number;
  pricePerMillion: number;
};

export type CacheWritePriceTier = {
  maxCacheWriteTokens: number;
  pricePerMillion: number;
};

export type TieredInputPricing = {
  inputPrice: number;
  inputTiers?: InputPriceTier[];
};

export type TieredOutputPricing = {
  outputPrice: number;
  outputTiers?: OutputPriceTier[];
};

export type TieredCacheReadPricing = {
  cacheReadPrice?: number;
  cacheReadTiers?: CacheReadPriceTier[];
};

export type TieredCacheWritePricing = {
  cacheWritePrice?: number;
  cacheWriteTiers?: CacheWritePriceTier[];
};

/**
 * Estimated USD for tokenCount using optional cumulative tiers; uncovered tokens use scalarPerMillion.
 */
export function computeTieredSegmentCostUsd(
  tokenCount: number,
  scalarPerMillion: number,
  tiers?: SegmentPriceTier[] | undefined,
): number {
  const t = Math.max(0, tokenCount);
  if (!tiers?.length) {
    return (t / 1_000_000) * scalarPerMillion;
  }

  const sorted = [...tiers].sort((a, b) => a.maxTokens - b.maxTokens);
  let prevCeiling = 0;
  let remaining = t;
  let cost = 0;

  for (const tier of sorted) {
    if (remaining <= 0) break;
    const cap =
      tier.maxTokens === Infinity || tier.maxTokens === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : tier.maxTokens;
    const segmentWidth =
      cap === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Math.max(0, cap - prevCeiling);
    if (segmentWidth <= 0 && cap !== Number.POSITIVE_INFINITY) {
      prevCeiling = cap;
      continue;
    }
    const use = cap === Number.POSITIVE_INFINITY ? remaining : Math.min(remaining, segmentWidth);
    cost += (use / 1_000_000) * tier.pricePerMillion;
    remaining -= use;
    prevCeiling = cap;
  }

  if (remaining > 0) {
    cost += (remaining / 1_000_000) * scalarPerMillion;
  }

  return cost;
}

function inputTiersToSegments(tiers: InputPriceTier[]): SegmentPriceTier[] {
  return tiers.map((x) => ({ maxTokens: x.maxInputTokens, pricePerMillion: x.pricePerMillion }));
}

function outputTiersToSegments(tiers: OutputPriceTier[]): SegmentPriceTier[] {
  return tiers.map((x) => ({ maxTokens: x.maxOutputTokens, pricePerMillion: x.pricePerMillion }));
}

function cacheReadTiersToSegments(tiers: CacheReadPriceTier[]): SegmentPriceTier[] {
  return tiers.map((x) => ({ maxTokens: x.maxCacheReadTokens, pricePerMillion: x.pricePerMillion }));
}

function cacheWriteTiersToSegments(tiers: CacheWritePriceTier[]): SegmentPriceTier[] {
  return tiers.map((x) => ({ maxTokens: x.maxCacheWriteTokens, pricePerMillion: x.pricePerMillion }));
}

/**
 * Display price for OpenClaw model list: first-segment rate when tiers exist, else scalar inputPrice.
 */
export function getDisplayInputPricePerMillion(pricing: TieredInputPricing): number {
  const first = pricing.inputTiers?.[0];
  if (first && typeof first.pricePerMillion === "number") {
    return first.pricePerMillion;
  }
  return pricing.inputPrice;
}

/** First output segment rate or scalar outputPrice. */
export function getDisplayOutputPricePerMillion(pricing: TieredOutputPricing): number {
  const first = pricing.outputTiers?.[0];
  if (first && typeof first.pricePerMillion === "number") {
    return first.pricePerMillion;
  }
  return pricing.outputPrice;
}

/** First cache-read segment or scalar (default 0). */
export function getDisplayCacheReadPricePerMillion(pricing: TieredCacheReadPricing): number {
  const first = pricing.cacheReadTiers?.[0];
  if (first && typeof first.pricePerMillion === "number") {
    return first.pricePerMillion;
  }
  return pricing.cacheReadPrice ?? 0;
}

/** First cache-write segment or scalar (default 0). */
export function getDisplayCacheWritePricePerMillion(pricing: TieredCacheWritePricing): number {
  const first = pricing.cacheWriteTiers?.[0];
  if (first && typeof first.pricePerMillion === "number") {
    return first.pricePerMillion;
  }
  return pricing.cacheWritePrice ?? 0;
}

/**
 * Estimated USD cost for input tokens only (no output, no margin).
 */
export function computeTieredInputCostUsd(inputTokens: number, pricing: TieredInputPricing): number {
  const tiers = pricing.inputTiers?.length ? inputTiersToSegments(pricing.inputTiers) : undefined;
  return computeTieredSegmentCostUsd(inputTokens, pricing.inputPrice, tiers);
}

/** Estimated USD for completion tokens (no margin). */
export function computeTieredOutputCostUsd(outputTokens: number, pricing: TieredOutputPricing): number {
  const tiers = pricing.outputTiers?.length ? outputTiersToSegments(pricing.outputTiers) : undefined;
  return computeTieredSegmentCostUsd(outputTokens, pricing.outputPrice, tiers);
}

/** Estimated USD for cache read tokens (no margin). */
export function computeTieredCacheReadCostUsd(
  cacheReadTokens: number,
  pricing: TieredCacheReadPricing,
): number {
  const scalar = pricing.cacheReadPrice ?? 0;
  const tiers = pricing.cacheReadTiers?.length
    ? cacheReadTiersToSegments(pricing.cacheReadTiers)
    : undefined;
  return computeTieredSegmentCostUsd(cacheReadTokens, scalar, tiers);
}

/** Estimated USD for cache write tokens (no margin). */
export function computeTieredCacheWriteCostUsd(
  cacheWriteTokens: number,
  pricing: TieredCacheWritePricing,
): number {
  const scalar = pricing.cacheWritePrice ?? 0;
  const tiers = pricing.cacheWriteTiers?.length
    ? cacheWriteTiersToSegments(pricing.cacheWriteTiers)
    : undefined;
  return computeTieredSegmentCostUsd(cacheWriteTokens, scalar, tiers);
}
