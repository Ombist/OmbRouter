import type { IncomingMessage, ServerResponse } from "node:http";
import { paymentStore } from "../payment-context.js";
import { proxyPartnerRequest } from "./partner-proxy.js";
import type { AuxiliaryRouteContext } from "./context.js";
import { auxiliaryHttpRoutesEnabled } from "../upstream-capabilities.js";

export async function tryPartnerAndNotV1Routes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  if (req.url?.match(/^\/v1\/(?:x|partner|pm)\//)) {
    if (
      !auxiliaryHttpRoutesEnabled(ctx.options.upstreamMode ?? "x402", ctx.options.apiKeyAllowAuxRoutes)
    ) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Partner / x402 proxy routes are not available in apiKey mode. Use upstreamMode x402 or moonpay with a BlockRun-compatible HTTPS apiBase, or see https://agents.moonpay.com/skill.md for MoonPay tooling.",
            type: "not_supported",
            code: "upstream_mode_api_key",
          },
        }),
      );
      return true;
    }
    try {
      await proxyPartnerRequest(
        req,
        res,
        ctx.apiBase,
        ctx.payFetch,
        () => paymentStore.getStore()?.amountUsd ?? 0,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      ctx.options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Partner proxy error: ${error.message}`, type: "partner_error" },
          }),
        );
      }
    }
    return true;
  }

  if (!req.url?.startsWith("/v1")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return true;
  }

  return false;
}
