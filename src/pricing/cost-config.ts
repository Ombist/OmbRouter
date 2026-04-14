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
};

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
