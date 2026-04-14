/**
 * Unit tests for session budget evaluation (strict cap, graceful precheck, chain filter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateStrictCostCap,
  evaluateGracefulBudgetPrecheck,
  applyGracefulBudgetModelFilter,
  type EstimateAmountFn,
} from "./budget.js";
import { FREE_MODEL } from "./free-models.js";

const micro = (usd: number) => String(Math.round(usd * 1_000_000));

describe("evaluateStrictCostCap", () => {
  const estimateAlwaysCheap: EstimateAmountFn = () => micro(0.01);

  it("returns null when not in strict mode", () => {
    expect(
      evaluateStrictCostCap({
        maxCostPerRunUsd: 1,
        effectiveSessionId: "sess",
        isFreeModel: false,
        maxCostPerRunMode: "graceful",
        runCostUsd: 0,
        modelId: "openai/gpt-4o",
        bodyLength: 100,
        maxTokens: 4096,
        estimateAmount: estimateAlwaysCheap,
      }),
    ).toBeNull();
  });

  it("returns null for free model path", () => {
    expect(
      evaluateStrictCostCap({
        maxCostPerRunUsd: 1,
        effectiveSessionId: "sess",
        isFreeModel: true,
        maxCostPerRunMode: "strict",
        runCostUsd: 0,
        modelId: FREE_MODEL,
        bodyLength: 100,
        maxTokens: 4096,
        estimateAmount: estimateAlwaysCheap,
      }),
    ).toBeNull();
  });

  it("returns null when projected spend is within cap", () => {
    expect(
      evaluateStrictCostCap({
        maxCostPerRunUsd: 1,
        effectiveSessionId: "sess",
        isFreeModel: false,
        maxCostPerRunMode: "strict",
        runCostUsd: 0.5,
        modelId: "m",
        bodyLength: 100,
        maxTokens: 4096,
        estimateAmount: () => micro(0.4),
      }),
    ).toBeNull();
  });

  it("blocks when projected spend exceeds cap", () => {
    const r = evaluateStrictCostCap({
      maxCostPerRunUsd: 1,
      effectiveSessionId: "sess",
      isFreeModel: false,
      maxCostPerRunMode: "strict",
      runCostUsd: 0.6,
      modelId: "m",
      bodyLength: 100,
      maxTokens: 4096,
      estimateAmount: () => micro(0.5),
    });
    expect(r?.kind).toBe("strict_cap");
    expect(r?.projectedCostUsd).toBeCloseTo(1.1, 5);
    expect(r?.limit).toBe(1);
  });

  it("uses estimatedCostMicros when provided", () => {
    const r = evaluateStrictCostCap({
      maxCostPerRunUsd: 1,
      effectiveSessionId: "sess",
      isFreeModel: false,
      maxCostPerRunMode: "strict",
      runCostUsd: 0.5,
      modelId: "m",
      bodyLength: 100,
      maxTokens: 4096,
      estimatedCostMicros: 600_000_000n,
      estimateAmount: () => micro(999),
    });
    expect(r?.kind).toBe("strict_cap");
    expect(r?.thisReqEstUsd).toBe(600);
  });
});

describe("evaluateGracefulBudgetPrecheck", () => {
  /** Every paid model costs $10 — nothing fits tiny remaining budget */
  const estimateExpensive: EstimateAmountFn = (id) => {
    if (id.startsWith("free/")) return micro(0);
    return micro(10);
  };

  it("returns null when mode is strict", () => {
    expect(
      evaluateGracefulBudgetPrecheck({
        maxCostPerRunUsd: 1,
        effectiveSessionId: "s",
        isFreeModel: false,
        maxCostPerRunMode: "strict",
        runCostUsd: 0,
        hasTools: true,
        routingDecision: undefined,
        modelId: "x",
        bodyLength: 1,
        maxTokens: 1,
        estimateAmount: estimateExpensive,
      }),
    ).toBeNull();
  });

  it("blocks agentic path when no non-free model is affordable", () => {
    const r = evaluateGracefulBudgetPrecheck({
      maxCostPerRunUsd: 1,
      effectiveSessionId: "s",
      isFreeModel: false,
      maxCostPerRunMode: "graceful",
      runCostUsd: 0.99,
      hasTools: true,
      routingDecision: {
        model: "openai/gpt-4o",
        tier: "SIMPLE",
        confidence: 1,
        reasoning: "",
        costEstimate: 0,
        baselineCost: 0,
        savings: 0,
      } as import("../../router/index.js").RoutingDecision,
      modelId: "openai/gpt-4o",
      bodyLength: 1,
      maxTokens: 1,
      estimateAmount: estimateExpensive,
    });
    expect(r?.variant).toBe("agentic");
    expect(r?.remainingUsd).toBeCloseTo(0.01, 5);
  });

  it("blocks explicit model when user cannot afford chosen model", () => {
    const r = evaluateGracefulBudgetPrecheck({
      maxCostPerRunUsd: 1,
      effectiveSessionId: "s",
      isFreeModel: false,
      maxCostPerRunMode: "graceful",
      runCostUsd: 0.5,
      hasTools: false,
      routingDecision: undefined,
      modelId: "openai/gpt-4o",
      bodyLength: 1,
      maxTokens: 1,
      estimateAmount: () => micro(0.6),
    });
    expect(r?.variant).toBe("explicit_model");
    expect(r?.explicitModelId).toBe("openai/gpt-4o");
  });

  it("allows explicit model when estimate is undefined (permissive)", () => {
    expect(
      evaluateGracefulBudgetPrecheck({
        maxCostPerRunUsd: 1,
        effectiveSessionId: "s",
        isFreeModel: false,
        maxCostPerRunMode: "graceful",
        runCostUsd: 0.5,
        hasTools: false,
        routingDecision: undefined,
        modelId: "unknown/model",
        bodyLength: 1,
        maxTokens: 1,
        estimateAmount: () => undefined,
      }),
    ).toBeNull();
  });
});

describe("applyGracefulBudgetModelFilter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("passes through when cap or session missing", () => {
    const r = applyGracefulBudgetModelFilter({
      modelsToTry: ["a", "b"],
      maxCostPerRunUsd: undefined,
      effectiveSessionId: "s",
      isFreeModel: false,
      maxCostPerRunMode: "graceful",
      runCostUsd: 0,
      hasTools: false,
      routingDecision: { tier: "SIMPLE" } as import("../../router/index.js").RoutingDecision,
      bodyLength: 1,
      maxTokens: 1,
      estimateAmount: () => micro(1),
      limitUsd: 1,
    });
    expect(r.outcome).toBe("continue");
    if (r.outcome === "continue") expect(r.modelsToTry).toEqual(["a", "b"]);
  });

  it("returns block_complex_free_only when only free models remain on complex path", () => {
    const r = applyGracefulBudgetModelFilter({
      modelsToTry: ["openai/gpt-4o", FREE_MODEL],
      maxCostPerRunUsd: 1,
      effectiveSessionId: "s",
      isFreeModel: false,
      maxCostPerRunMode: "graceful",
      runCostUsd: 0.99,
      hasTools: true,
      routingDecision: {
        tier: "SIMPLE",
      } as import("../../router/index.js").RoutingDecision,
      bodyLength: 1,
      maxTokens: 1,
      estimateAmount: (id) => (id.startsWith("free/") ? micro(0) : micro(0.05)),
      limitUsd: 1,
    });
    expect(r.outcome).toBe("block_complex_free_only");
    if (r.outcome === "block_complex_free_only") {
      expect(r.errPayload.error.code).toBe("budget_exhausted");
      expect(r.budgetSummary).toContain("remaining");
    }
  });

  it("adds downgrade notice when some models excluded", () => {
    const r = applyGracefulBudgetModelFilter({
      modelsToTry: ["openai/gpt-4o", FREE_MODEL],
      maxCostPerRunUsd: 2,
      effectiveSessionId: "s",
      isFreeModel: false,
      maxCostPerRunMode: "graceful",
      runCostUsd: 1.5,
      hasTools: false,
      routingDecision: {
        tier: "SIMPLE",
      } as import("../../router/index.js").RoutingDecision,
      bodyLength: 1,
      maxTokens: 1,
      estimateAmount: (id) => (id.startsWith("free/") ? micro(0) : micro(0.6)),
      limitUsd: 2,
    });
    expect(r.outcome).toBe("continue");
    if (r.outcome === "continue") {
      expect(r.excluded).toContain("openai/gpt-4o");
      expect(r.budgetDowngradeNotice).toContain("Budget");
      expect(r.budgetDowngradeHeaderMode).toBe("downgraded");
      expect(r.modelsToTry.every((m) => m.startsWith("free/"))).toBe(true);
    }
  });
});
