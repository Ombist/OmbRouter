import { describe, expect, it } from "vitest";
import {
  computeTieredInputCostUsd,
  computeTieredOutputCostUsd,
  computeTieredSegmentCostUsd,
  getDisplayInputPricePerMillion,
  type InputPriceTier,
  type SegmentPriceTier,
} from "./tiered-input.js";

describe("computeTieredInputCostUsd", () => {
  it("falls back to linear inputPrice when no tiers", () => {
    expect(computeTieredInputCostUsd(1_000_000, { inputPrice: 2 })).toBe(2);
    expect(computeTieredInputCostUsd(0, { inputPrice: 5 })).toBe(0);
  });

  it("first segment only when under first cap", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: 32_768, pricePerMillion: 1 },
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 3 },
    ];
    // 10k at $1/M = 0.01
    expect(computeTieredInputCostUsd(10_000, { inputPrice: 99, inputTiers: tiers })).toBeCloseTo(
      0.01,
      8,
    );
  });

  it("splits at 32k boundary", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: 32_768, pricePerMillion: 1 },
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 2 },
    ];
    // 32_768 @ $1/M + (50_000 - 32_768) @ $2/M
    const cost = computeTieredInputCostUsd(50_000, { inputPrice: 0, inputTiers: tiers });
    const expected =
      (32_768 / 1_000_000) * 1 + ((50_000 - 32_768) / 1_000_000) * 2;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("exactly on boundary: all first tier", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: 32_768, pricePerMillion: 1 },
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 2 },
    ];
    const cost = computeTieredInputCostUsd(32_768, { inputPrice: 0, inputTiers: tiers });
    expect(cost).toBeCloseTo(32_768 / 1_000_000, 8);
  });

  it("one token in second tier", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: 32_768, pricePerMillion: 1 },
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 2 },
    ];
    const cost = computeTieredInputCostUsd(32_769, { inputPrice: 0, inputTiers: tiers });
    expect(cost).toBeCloseTo(32_768 / 1_000_000 + 1 / 1_000_000 * 2, 8);
  });

  it("three tiers", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: 10_000, pricePerMillion: 1 },
      { maxInputTokens: 20_000, pricePerMillion: 2 },
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 4 },
    ];
    // 25k total: 10k@1 + 10k@2 + 5k@4 = 0.01 + 0.02 + 0.02 = 0.05
    const cost = computeTieredInputCostUsd(25_000, { inputPrice: 0, inputTiers: tiers });
    expect(cost).toBeCloseTo(0.05, 8);
  });

  it("tail uses inputPrice when tiers exhausted with finite caps", () => {
    const tiers: InputPriceTier[] = [{ maxInputTokens: 1000, pricePerMillion: 1 }];
    // 2000 tokens: 1000@1 + 1000@inputPrice 5 = 0.001 + 0.005 = 0.006
    const cost = computeTieredInputCostUsd(2000, { inputPrice: 5, inputTiers: tiers });
    expect(cost).toBeCloseTo(0.001 + 0.005, 8);
  });

  it("unsorted tiers are ordered by maxInputTokens", () => {
    const tiers: InputPriceTier[] = [
      { maxInputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 2 },
      { maxInputTokens: 32_768, pricePerMillion: 1 },
    ];
    const cost = computeTieredInputCostUsd(50_000, { inputPrice: 0, inputTiers: tiers });
    const expected =
      (32_768 / 1_000_000) * 1 + ((50_000 - 32_768) / 1_000_000) * 2;
    expect(cost).toBeCloseTo(expected, 8);
  });
});

describe("computeTieredSegmentCostUsd", () => {
  it("matches linear when no tiers", () => {
    expect(computeTieredSegmentCostUsd(500_000, 3, undefined)).toBe(1.5);
  });

  it("uses tier segments", () => {
    const tiers: SegmentPriceTier[] = [
      { maxTokens: 100_000, pricePerMillion: 1 },
      { maxTokens: Number.POSITIVE_INFINITY, pricePerMillion: 4 },
    ];
    const cost = computeTieredSegmentCostUsd(150_000, 9, tiers);
    expect(cost).toBeCloseTo(0.1 + 0.2, 8);
  });
});

describe("computeTieredOutputCostUsd", () => {
  it("tiers output tokens", () => {
    const cost = computeTieredOutputCostUsd(10_000, {
      outputPrice: 0,
      outputTiers: [
        { maxOutputTokens: 8000, pricePerMillion: 2 },
        { maxOutputTokens: Number.POSITIVE_INFINITY, pricePerMillion: 6 },
      ],
    });
    expect(cost).toBeCloseTo(8000 / 1e6 * 2 + 2000 / 1e6 * 6, 8);
  });
});

describe("getDisplayInputPricePerMillion", () => {
  it("uses first tier when present", () => {
    expect(
      getDisplayInputPricePerMillion({
        inputPrice: 9,
        inputTiers: [
          { maxInputTokens: 32_768, pricePerMillion: 1 },
          { maxInputTokens: Infinity, pricePerMillion: 3 },
        ],
      }),
    ).toBe(1);
  });

  it("uses inputPrice without tiers", () => {
    expect(getDisplayInputPricePerMillion({ inputPrice: 2.5 })).toBe(2.5);
  });
});
