/**
 * Optional user overrides for per-model pricing (USD per 1M tokens, optional flat per request).
 * Loaded from cost_config.json — see docs/configuration.md.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { BLOCKRUN_MODELS, getActivePromoPrice } from "../models.js";
import type { ModelPricing } from "../router/selector.js";
import type {
  CacheReadPriceTier,
  CacheWritePriceTier,
  InputPriceTier,
  OutputPriceTier,
  SegmentPriceTier,
} from "./tiered-input.js";
import { AUTO_MODEL } from "../proxy/chat/free-models.js";

/** Root object in cost_config.json */
export type CostConfigFile = {
  models?: Record<string, CostConfigEntry>;
};

export type CostConfigEntry = {
  inputPrice?: number;
  outputPrice?: number;
  /** Fixed USD per request — overrides built-in promo flat for this model when set. */
  flatPrice?: number;
  /** When true, drop flat pricing (promo or override) and use token input/output only. */
  clearFlatPrice?: boolean;
  /**
   * Cumulative input tiers ($/1M per segment). Last entry may use `"maxInputTokens": null` for remainder.
   * When set, replaces built-in tiers for this model.
   */
  inputTiers?: CostConfigInputTierJson[];
  /** When true, remove tiered input pricing and use scalar inputPrice only. */
  clearInputTiers?: boolean;
  outputTiers?: CostConfigOutputTierJson[];
  clearOutputTiers?: boolean;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  cacheReadTiers?: CostConfigCacheReadTierJson[];
  cacheWriteTiers?: CostConfigCacheWriteTierJson[];
  clearCacheReadTiers?: boolean;
  clearCacheWriteTiers?: boolean;
};

/** JSON shape: null maxInputTokens means remainder (Infinity). */
export type CostConfigInputTierJson = {
  maxInputTokens: number | null;
  pricePerMillion: number;
};

export type CostConfigOutputTierJson = {
  maxOutputTokens: number | null;
  pricePerMillion: number;
};

export type CostConfigCacheReadTierJson = {
  maxCacheReadTokens: number | null;
  pricePerMillion: number;
};

export type CostConfigCacheWriteTierJson = {
  maxCacheWriteTokens: number | null;
  pricePerMillion: number;
};

type MaxField =
  | "maxInputTokens"
  | "maxOutputTokens"
  | "maxCacheReadTokens"
  | "maxCacheWriteTokens";

function parseConfigTiersRaw(raw: unknown, maxField: MaxField): SegmentPriceTier[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SegmentPriceTier[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.pricePerMillion !== "number") continue;
    const maxRaw = o[maxField];
    let maxTokens: number;
    if (maxRaw === null || maxRaw === undefined) {
      maxTokens = Number.POSITIVE_INFINITY;
    } else if (typeof maxRaw === "number" && Number.isFinite(maxRaw)) {
      maxTokens = maxRaw;
    } else {
      continue;
    }
    out.push({ maxTokens, pricePerMillion: o.pricePerMillion });
  }
  return out.length ? out : undefined;
}

function parseConfigInputTiers(raw: unknown): InputPriceTier[] | undefined {
  const segs = parseConfigTiersRaw(raw, "maxInputTokens");
  return segs?.map((s) => ({ maxInputTokens: s.maxTokens, pricePerMillion: s.pricePerMillion }));
}

function parseConfigOutputTiers(raw: unknown): OutputPriceTier[] | undefined {
  const segs = parseConfigTiersRaw(raw, "maxOutputTokens");
  return segs?.map((s) => ({ maxOutputTokens: s.maxTokens, pricePerMillion: s.pricePerMillion }));
}

function parseConfigCacheReadTiers(raw: unknown): CacheReadPriceTier[] | undefined {
  const segs = parseConfigTiersRaw(raw, "maxCacheReadTokens");
  return segs?.map((s) => ({ maxCacheReadTokens: s.maxTokens, pricePerMillion: s.pricePerMillion }));
}

function parseConfigCacheWriteTiers(raw: unknown): CacheWritePriceTier[] | undefined {
  const segs = parseConfigTiersRaw(raw, "maxCacheWriteTokens");
  return segs?.map((s) => ({ maxCacheWriteTokens: s.maxTokens, pricePerMillion: s.pricePerMillion }));
}

export function resolveCostConfigPath(options: { costConfigPath?: string }): string {
  const fromEnv = process.env.OMBROUTER_COST_CONFIG?.trim();
  if (options.costConfigPath?.trim()) return pathResolve(options.costConfigPath.trim());
  if (fromEnv) return pathResolve(fromEnv);
  return join(homedir(), ".openclaw", "blockrun", "cost_config.json");
}

/**
 * Read and parse cost_config.json. Returns SHA-256 hex of file bytes (or "" if missing).
 * Invalid JSON logs a warning and yields undefined payload (revision still reflects file bytes if read).
 */
export function loadCostConfigPayload(path: string): {
  raw: CostConfigFile | undefined;
  revision: string;
} {
  if (!existsSync(path)) {
    return { raw: undefined, revision: "" };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    console.warn(
      `[OmbRouter] cost_config: cannot read ${path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { raw: undefined, revision: "" };
  }
  const revision = createHash("sha256").update(content).digest("hex");
  const trimmed = content.trim();
  if (!trimmed) {
    return { raw: undefined, revision };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    console.warn(
      `[OmbRouter] cost_config: invalid JSON at ${path} — ${e instanceof Error ? e.message : String(e)}`,
    );
    return { raw: undefined, revision };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[OmbRouter] cost_config: root must be a JSON object`);
    return { raw: undefined, revision };
  }
  const models = (parsed as Record<string, unknown>)["models"];
  if (
    models !== undefined &&
    (models === null || typeof models !== "object" || Array.isArray(models))
  ) {
    console.warn(`[OmbRouter] cost_config: "models" must be an object`);
    return { raw: undefined, revision };
  }
  return { raw: parsed as CostConfigFile, revision };
}

/**
 * Build pricing map from BLOCKRUN_MODELS + active promos (same as legacy proxy buildModelPricing).
 */
export function buildBaseModelPricingMap(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue;
    const promoPrice = getActivePromoPrice(m);
    map.set(m.id, {
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      ...(m.inputTiers?.length ? { inputTiers: m.inputTiers } : {}),
      ...(m.outputTiers?.length ? { outputTiers: m.outputTiers } : {}),
      ...(m.cacheReadPrice !== undefined ? { cacheReadPrice: m.cacheReadPrice } : {}),
      ...(m.cacheWritePrice !== undefined ? { cacheWritePrice: m.cacheWritePrice } : {}),
      ...(m.cacheReadTiers?.length ? { cacheReadTiers: m.cacheReadTiers } : {}),
      ...(m.cacheWriteTiers?.length ? { cacheWriteTiers: m.cacheWriteTiers } : {}),
      ...(promoPrice !== undefined && { flatPrice: promoPrice }),
    });
  }
  return map;
}

export function applyCostConfigOverrides(
  base: Map<string, ModelPricing>,
  raw: CostConfigFile | undefined,
  warn?: (msg: string) => void,
): Map<string, ModelPricing> {
  if (!raw?.models || typeof raw.models !== "object") {
    return new Map(base);
  }
  const validIds = new Set(BLOCKRUN_MODELS.map((m) => m.id));
  const out = new Map(base);
  for (const [id, entry] of Object.entries(raw.models)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!validIds.has(id)) {
      warn?.(`[OmbRouter] cost_config: unknown model id "${id}" — ignored`);
      continue;
    }
    const cur = out.get(id);
    if (!cur) continue;
    const next: ModelPricing = { ...cur };
    const e = entry as CostConfigEntry;
    if (typeof e.inputPrice === "number") next.inputPrice = e.inputPrice;
    if (typeof e.outputPrice === "number") next.outputPrice = e.outputPrice;
    if (e.clearFlatPrice === true) {
      delete next.flatPrice;
    } else if (typeof e.flatPrice === "number") {
      next.flatPrice = e.flatPrice;
    }
    if (e.clearInputTiers === true) {
      delete next.inputTiers;
    } else if (e.inputTiers !== undefined) {
      if (Array.isArray(e.inputTiers) && e.inputTiers.length === 0) {
        delete next.inputTiers;
      } else {
        const parsed = parseConfigInputTiers(e.inputTiers);
        if (parsed) {
          next.inputTiers = parsed;
        } else {
          warn?.(`[OmbRouter] cost_config: invalid inputTiers for "${id}" — ignored`);
        }
      }
    }
    if (e.clearOutputTiers === true) {
      delete next.outputTiers;
    } else if (e.outputTiers !== undefined) {
      if (Array.isArray(e.outputTiers) && e.outputTiers.length === 0) {
        delete next.outputTiers;
      } else {
        const parsed = parseConfigOutputTiers(e.outputTiers);
        if (parsed) {
          next.outputTiers = parsed;
        } else {
          warn?.(`[OmbRouter] cost_config: invalid outputTiers for "${id}" — ignored`);
        }
      }
    }
    if (typeof e.cacheReadPrice === "number") next.cacheReadPrice = e.cacheReadPrice;
    if (typeof e.cacheWritePrice === "number") next.cacheWritePrice = e.cacheWritePrice;
    if (e.clearCacheReadTiers === true) {
      delete next.cacheReadTiers;
    } else if (e.cacheReadTiers !== undefined) {
      if (Array.isArray(e.cacheReadTiers) && e.cacheReadTiers.length === 0) {
        delete next.cacheReadTiers;
      } else {
        const parsed = parseConfigCacheReadTiers(e.cacheReadTiers);
        if (parsed) {
          next.cacheReadTiers = parsed;
        } else {
          warn?.(`[OmbRouter] cost_config: invalid cacheReadTiers for "${id}" — ignored`);
        }
      }
    }
    if (e.clearCacheWriteTiers === true) {
      delete next.cacheWriteTiers;
    } else if (e.cacheWriteTiers !== undefined) {
      if (Array.isArray(e.cacheWriteTiers) && e.cacheWriteTiers.length === 0) {
        delete next.cacheWriteTiers;
      } else {
        const parsed = parseConfigCacheWriteTiers(e.cacheWriteTiers);
        if (parsed) {
          next.cacheWriteTiers = parsed;
        } else {
          warn?.(`[OmbRouter] cost_config: invalid cacheWriteTiers for "${id}" — ignored`);
        }
      }
    }
    out.set(id, next);
  }
  return out;
}

export function buildEffectiveModelPricing(
  raw: CostConfigFile | undefined,
  warn?: (msg: string) => void,
): Map<string, ModelPricing> {
  const base = buildBaseModelPricingMap();
  return applyCostConfigOverrides(base, raw, warn);
}
