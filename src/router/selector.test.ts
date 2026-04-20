import { describe, expect, it } from "vitest";

import {
  calculateModelCost,
  filterByExcludeList,
  filterByToolCalling,
  selectModel,
  type ModelPricing,
} from "./selector.js";
import { computeTieredInputCostUsd, computeTieredOutputCostUsd } from "../pricing/tiered-input.js";
import type { TierConfig } from "./types.js";

const TIER_CONFIGS: Record<"SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING", TierConfig> = {
  SIMPLE: { primary: "moonshot/kimi-k2.5", fallback: [] },
  MEDIUM: { primary: "moonshot/kimi-k2.5", fallback: [] },
  COMPLEX: { primary: "moonshot/kimi-k2.5", fallback: [] },
  REASONING: { primary: "moonshot/kimi-k2.5", fallback: [] },
};

const MODEL_PRICING = new Map<string, ModelPricing>([
  ["moonshot/kimi-k2.5", { inputPrice: 0.5, outputPrice: 2.4 }],
  ["anthropic/claude-opus-4.6", { inputPrice: 5, outputPrice: 25 }],
]);

describe("selectModel", () => {
  it("uses claude-opus-4.6 as baseline ID when computing savings", () => {
    const decision = selectModel(
      "SIMPLE",
      0.95,
      "rules",
      "test",
      TIER_CONFIGS,
      MODEL_PRICING,
      1000,
      1000,
    );

    expect(decision.baselineCost).toBeGreaterThan(0);
    expect(decision.savings).toBeGreaterThan(0);
  });
});

describe("filterByToolCalling", () => {
  const supportsToolCalling = (modelId: string) =>
    !["minimax/minimax-m2.5", "nvidia/gpt-oss-120b"].includes(modelId);

  it("removes models without tool calling support when request has tools", () => {
    const models = ["moonshot/kimi-k2.5", "minimax/minimax-m2.5", "deepseek/deepseek-chat"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(["moonshot/kimi-k2.5", "deepseek/deepseek-chat"]);
  });

  it("keeps all models when request has no tools", () => {
    const models = ["moonshot/kimi-k2.5", "minimax/minimax-m2.5", "nvidia/gpt-oss-120b"];
    const filtered = filterByToolCalling(models, false, supportsToolCalling);
    expect(filtered).toEqual(models);
  });

  it("returns original list unchanged when all models support tool calling", () => {
    const models = ["moonshot/kimi-k2.5", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-chat"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(models);
  });

  it("returns full list unchanged when no models support tool calling, to avoid empty chain", () => {
    const models = ["minimax/minimax-m2.5", "nvidia/gpt-oss-120b"];
    const filtered = filterByToolCalling(models, true, supportsToolCalling);
    expect(filtered).toEqual(models);
  });
});

describe("filterByExcludeList", () => {
  const chain = ["moonshot/kimi-k2.5", "deepseek/deepseek-chat", "anthropic/claude-sonnet-4.6"];

  it("removes excluded models from chain", () => {
    const excludeList = new Set(["deepseek/deepseek-chat"]);
    const filtered = filterByExcludeList(chain, excludeList);
    expect(filtered).toEqual(["moonshot/kimi-k2.5", "anthropic/claude-sonnet-4.6"]);
  });

  it("returns original chain if ALL models excluded (safety net)", () => {
    const excludeList = new Set(chain);
    const filtered = filterByExcludeList(chain, excludeList);
    expect(filtered).toEqual(chain);
  });

  it("returns original chain for empty exclude set", () => {
    const filtered = filterByExcludeList(chain, new Set());
    expect(filtered).toEqual(chain);
  });
});

describe("calculateModelCost", () => {
  it("uses claude-opus-4.6 as baseline ID when recomputing fallback costs", () => {
    const costs = calculateModelCost("moonshot/kimi-k2.5", MODEL_PRICING, 1000, 1000);

    expect(costs.baselineCost).toBeGreaterThan(0);
    expect(costs.savings).toBeGreaterThan(0);
  });

  it("applies tiered input pricing before margin", () => {
    const tieredMap = new Map<string, ModelPricing>([
      [
        "moonshot/kimi-k2.5",
        {
          inputPrice: 0,
          outputPrice: 0,
          inputTiers: [
            { maxInputTokens: 32_768, pricePerMillion: 1 },
            { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 2 },
          ],
        },
      ],
      ["anthropic/claude-opus-4.6", { inputPrice: 5, outputPrice: 25 }],
    ]);
    const costs = calculateModelCost("moonshot/kimi-k2.5", tieredMap, 50_000, 0);
    const tieredPricing = tieredMap.get("moonshot/kimi-k2.5");
    expect(tieredPricing?.inputTiers).toBeDefined();
    const rawInput = computeTieredInputCostUsd(50_000, {
      inputPrice: 0,
      inputTiers: tieredPricing?.inputTiers,
    });
    expect(rawInput).toBeGreaterThan(0);
    expect(costs.costEstimate).toBeCloseTo(Math.max(rawInput * 1.05, 0.001), 8);
  });

  it("applies tiered output pricing before margin", () => {
    const map = new Map<string, ModelPricing>([
      [
        "moonshot/kimi-k2.5",
        {
          inputPrice: 0,
          outputPrice: 0,
          outputTiers: [
            { maxOutputTokens: 4096, pricePerMillion: 2 },
            { maxOutputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 8 },
          ],
        },
      ],
      ["anthropic/claude-opus-4.6", { inputPrice: 5, outputPrice: 25 }],
    ]);
    const costs = calculateModelCost("moonshot/kimi-k2.5", map, 0, 8192);
    const priced = map.get("moonshot/kimi-k2.5");
    expect(priced?.outputTiers).toBeDefined();
    const rawOut = computeTieredOutputCostUsd(8192, {
      outputPrice: 0,
      outputTiers: priced?.outputTiers,
    });
    expect(costs.costEstimate).toBeCloseTo(Math.max(rawOut * 1.05, 0.001), 8);
  });

  it("includes cache read/write when tokens provided", () => {
    const map = new Map<string, ModelPricing>([
      [
        "moonshot/kimi-k2.5",
        {
          inputPrice: 0,
          outputPrice: 0,
          cacheReadPrice: 1,
          cacheWritePrice: 5,
        },
      ],
      ["anthropic/claude-opus-4.6", { inputPrice: 5, outputPrice: 25 }],
    ]);
    const costs = calculateModelCost("moonshot/kimi-k2.5", map, 0, 0, undefined, {
      estimatedCacheReadTokens: 1_000_000,
      estimatedCacheWriteTokens: 100_000,
    });
    const raw = 1 + 0.5; // $1/M read + $5/M * 0.1M write
    expect(costs.costEstimate).toBeCloseTo(Math.max(raw * 1.05, 0.001), 8);
  });
});
