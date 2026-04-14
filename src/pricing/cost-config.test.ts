import { describe, it, expect } from "vitest";
import {
  applyCostConfigOverrides,
  buildBaseModelPricingMap,
  buildEffectiveModelPricing,
} from "./cost-config.js";
import { createEstimateAmount } from "../proxy/estimate-amount.js";

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
