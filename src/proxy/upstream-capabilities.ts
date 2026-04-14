import type { UpstreamMode } from "./upstream-transport.js";

/**
 * Partner (`/v1/x/…`, `/v1/partner/…`), image, and audio POST routes forward to
 * the configured `apiBase` via `payFetch` (BlockRun-style x402). Only `apiKey`
 * mode disables them unless `apiKeyAllowAuxRoutes` is enabled (Bearer forward).
 */
export function upstreamSupportsPaidBlockRunAuxRoutes(mode: UpstreamMode): boolean {
  return mode === "x402" || mode === "moonpay";
}

/**
 * True when image/audio/partner auxiliary routes are served: x402, moonpay, or
 * apiKey with optional Bearer forwarding to `upstreamApiBase`.
 */
export function auxiliaryHttpRoutesEnabled(
  mode: UpstreamMode,
  apiKeyAllowAuxRoutes?: boolean,
): boolean {
  if (mode === "x402" || mode === "moonpay") return true;
  return mode === "apiKey" && apiKeyAllowAuxRoutes === true;
}

/** Metadata for `GET /v1/models` and `/health` — list is always local routing registry. */
export type ModelsEndpointMeta = {
  /** Model IDs come from OmbRouter's OpenClaw routing registry (`OPENCLAW_MODELS`), not a live MoonPay or upstream catalog fetch. */
  source: "openclaw_router_registry";
  /** When true, partner / image / audio paths use BlockRun x402 micropayments (x402 or moonpay). */
  paidBlockRunAuxRoutesEnabled: boolean;
  /** When true, auxiliary HTTP routes (images, audio, partner) are accepted and forwarded. */
  auxiliaryHttpRoutesEnabled: boolean;
  /** How auxiliary routes are paid / authenticated: x402 chain, moonpay CLI, or Bearer to upstream. */
  auxiliaryHttpRoutesTransport: "x402" | "moonpay" | "bearer" | null;
};

export function modelsEndpointMeta(
  upstreamMode: UpstreamMode,
  apiKeyAllowAuxRoutes?: boolean,
): ModelsEndpointMeta {
  const paidBlock = upstreamSupportsPaidBlockRunAuxRoutes(upstreamMode);
  const auxEnabled = auxiliaryHttpRoutesEnabled(upstreamMode, apiKeyAllowAuxRoutes);
  let auxiliaryHttpRoutesTransport: "x402" | "moonpay" | "bearer" | null = null;
  if (upstreamMode === "x402") auxiliaryHttpRoutesTransport = "x402";
  else if (upstreamMode === "moonpay") auxiliaryHttpRoutesTransport = "moonpay";
  else if (upstreamMode === "apiKey" && apiKeyAllowAuxRoutes === true) {
    auxiliaryHttpRoutesTransport = "bearer";
  }
  return {
    source: "openclaw_router_registry",
    paidBlockRunAuxRoutesEnabled: paidBlock,
    auxiliaryHttpRoutesEnabled: auxEnabled,
    auxiliaryHttpRoutesTransport,
  };
}
