import { describe, expect, it } from "vitest";
import {
  auxiliaryHttpRoutesEnabled,
  modelsEndpointMeta,
  upstreamSupportsPaidBlockRunAuxRoutes,
} from "./upstream-capabilities.js";

describe("upstreamSupportsPaidBlockRunAuxRoutes", () => {
  it("is true for x402 and moonpay", () => {
    expect(upstreamSupportsPaidBlockRunAuxRoutes("x402")).toBe(true);
    expect(upstreamSupportsPaidBlockRunAuxRoutes("moonpay")).toBe(true);
  });

  it("is false for apiKey", () => {
    expect(upstreamSupportsPaidBlockRunAuxRoutes("apiKey")).toBe(false);
  });
});

describe("auxiliaryHttpRoutesEnabled", () => {
  it("is true for x402 and moonpay", () => {
    expect(auxiliaryHttpRoutesEnabled("x402")).toBe(true);
    expect(auxiliaryHttpRoutesEnabled("moonpay")).toBe(true);
  });

  it("is false for apiKey unless flag is true", () => {
    expect(auxiliaryHttpRoutesEnabled("apiKey")).toBe(false);
    expect(auxiliaryHttpRoutesEnabled("apiKey", false)).toBe(false);
    expect(auxiliaryHttpRoutesEnabled("apiKey", true)).toBe(true);
  });
});

describe("modelsEndpointMeta", () => {
  it("tags registry source and aux routes for x402/moonpay", () => {
    expect(modelsEndpointMeta("x402")).toEqual({
      source: "openclaw_router_registry",
      paidBlockRunAuxRoutesEnabled: true,
      auxiliaryHttpRoutesEnabled: true,
      auxiliaryHttpRoutesTransport: "x402",
    });
    expect(modelsEndpointMeta("moonpay")).toEqual({
      source: "openclaw_router_registry",
      paidBlockRunAuxRoutesEnabled: true,
      auxiliaryHttpRoutesEnabled: true,
      auxiliaryHttpRoutesTransport: "moonpay",
    });
  });

  it("disables BlockRun aux metadata for apiKey but can enable Bearer aux", () => {
    expect(modelsEndpointMeta("apiKey")).toEqual({
      source: "openclaw_router_registry",
      paidBlockRunAuxRoutesEnabled: false,
      auxiliaryHttpRoutesEnabled: false,
      auxiliaryHttpRoutesTransport: null,
    });
    expect(modelsEndpointMeta("apiKey", true)).toEqual({
      source: "openclaw_router_registry",
      paidBlockRunAuxRoutesEnabled: false,
      auxiliaryHttpRoutesEnabled: true,
      auxiliaryHttpRoutesTransport: "bearer",
    });
  });
});
