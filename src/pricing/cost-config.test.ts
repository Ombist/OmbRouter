import { describe, it, expect } from "vitest";
import {
  applyCostConfigOverrides,
  buildBaseModelPricingMap,
  buildEffectiveModelPricing,
} from "./cost-config.js";
import { createEstimateAmount } from "../proxy/estimate-amount.js";
import { computeTieredInputCostUsd, computeTieredOutputCostUsd } from "./tiered-input.js";

describe("cost-config merge", () => {
  it("overrides input and output prices", () => {
    const base = buildBaseModelPricingMap();
    const merged = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o": { inputPrice: 99, outputPrice: 88 },
      },
    });
    const p = merged.get("openai/gpt-4o");
    expect(p?.inputPrice).toBe(99);
    expect(p?.outputPrice).toBe(88);
  });

  it("sets flatPrice override", () => {
    const base = buildBaseModelPricingMap();
    const merged = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o-mini": { flatPrice: 0.042 },
      },
    });
    const p = merged.get("openai/gpt-4o-mini");
    expect(p?.flatPrice).toBe(0.042);
  });

  it("clearFlatPrice removes flat when present", () => {
    const base = buildBaseModelPricingMap();
    const withFlat = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o": { flatPrice: 0.05 },
      },
    });
    expect(withFlat.get("openai/gpt-4o")?.flatPrice).toBe(0.05);

    const merged = applyCostConfigOverrides(withFlat, {
      models: {
        "openai/gpt-4o": { clearFlatPrice: true },
      },
    });
    const p = merged.get("openai/gpt-4o");
    expect(p?.flatPrice).toBeUndefined();
  });

  it("merges inputTiers from cost config (null max = remainder)", () => {
    const base = buildBaseModelPricingMap();
    const merged = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o": {
          inputTiers: [
            { maxInputTokens: 32768, pricePerMillion: 1 },
            { maxInputTokens: null, pricePerMillion: 3 },
          ],
        },
      },
    });
    const p = merged.get("openai/gpt-4o");
    expect(p?.inputTiers?.length).toBe(2);
    expect(p?.inputTiers?.[1].maxInputTokens).toBe(Number.POSITIVE_INFINITY);
  });

  it("merges outputTiers and cache prices", () => {
    const base = buildBaseModelPricingMap();
    const merged = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o": {
          outputTiers: [
            { maxOutputTokens: 4096, pricePerMillion: 1 },
            { maxOutputTokens: null, pricePerMillion: 4 },
          ],
          cacheReadPrice: 0.5,
          cacheWritePrice: 6.25,
        },
      },
    });
    const p = merged.get("openai/gpt-4o");
    expect(p?.outputTiers?.length).toBe(2);
    expect(p?.cacheReadPrice).toBe(0.5);
    expect(p?.cacheWritePrice).toBe(6.25);
  });

  it("clearInputTiers removes tiered input", () => {
    const base = buildBaseModelPricingMap();
    const withTiers = applyCostConfigOverrides(base, {
      models: {
        "openai/gpt-4o": {
          inputTiers: [{ maxInputTokens: 1000, pricePerMillion: 1 }],
        },
      },
    });
    expect(withTiers.get("openai/gpt-4o")?.inputTiers).toBeDefined();

    const cleared = applyCostConfigOverrides(withTiers, {
      models: {
        "openai/gpt-4o": { clearInputTiers: true },
      },
    });
    expect(cleared.get("openai/gpt-4o")?.inputTiers).toBeUndefined();
  });

  it("ignores unknown model ids", () => {
    const warns: string[] = [];
    const merged = buildEffectiveModelPricing(
      {
        models: {
          "not/a-real-model": { inputPrice: 1 },
          "openai/gpt-4o": { inputPrice: 3 },
        },
      },
      (m) => warns.push(m),
    );
    expect(warns.some((w) => w.includes("not/a-real-model"))).toBe(true);
    expect(merged.get("openai/gpt-4o")?.inputPrice).toBe(3);
  });
});

describe("createEstimateAmount with overrides", () => {
  it("uses tiered output for estimate when outputTiers set", () => {
    const pricing = buildEffectiveModelPricing({
      models: {
        "openai/gpt-4o": {
          inputPrice: 0,
          outputPrice: 10,
          outputTiers: [
            { maxOutputTokens: 5000, pricePerMillion: 2 },
            { maxOutputTokens: null, pricePerMillion: 8 },
          ],
        },
      },
    });
    const est = createEstimateAmount(pricing);
    const micros = est("openai/gpt-4o", 100, 8000);
    const p4o = pricing.get("openai/gpt-4o");
    expect(p4o?.outputTiers?.length).toBe(2);
    const outUsd = computeTieredOutputCostUsd(8000, {
      outputPrice: 10,
      outputTiers: p4o?.outputTiers,
    });
    expect(Number(micros) / 1_000_000).toBeCloseTo(outUsd * 1.2, 4);
  });

  it("uses tiered input for estimate when inputTiers set", () => {
    const pricing = buildEffectiveModelPricing({
      models: {
        "openai/gpt-4o": {
          inputPrice: 10,
          outputPrice: 0,
          inputTiers: [
            { maxInputTokens: 32768, pricePerMillion: 1 },
            { maxInputTokens: null, pricePerMillion: 2 },
          ],
        },
      },
    });
    const est = createEstimateAmount(pricing);
    const bodyFor50kTokens = 50_000 * 4;
    const micros = est("openai/gpt-4o", bodyFor50kTokens, 1);
    expect(micros).toBeDefined();
    const inputUsd = computeTieredInputCostUsd(50_000, {
      inputPrice: 10,
      inputTiers: pricing.get("openai/gpt-4o")!.inputTiers,
    });
    const outputUsd = (1 / 1_000_000) * (pricing.get("openai/gpt-4o")!.outputPrice ?? 0);
    const expectedUsd = (inputUsd + outputUsd) * 1.2;
    expect(Number(micros) / 1_000_000).toBeCloseTo(expectedUsd, 4);
  });

  it("uses merged flat price for estimate", () => {
    const pricing = buildEffectiveModelPricing({
      models: {
        "openai/gpt-4o-mini": { flatPrice: 0.01 },
      },
    });
    const est = createEstimateAmount(pricing);
    const micros = est("openai/gpt-4o-mini", 100, 4096);
    expect(micros).toBeDefined();
    const usd = Number(micros) / 1_000_000;
    expect(usd).toBeCloseTo(0.01 * 1.2, 5);
  });
});
