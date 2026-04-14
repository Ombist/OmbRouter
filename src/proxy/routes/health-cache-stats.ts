import type { IncomingMessage, ServerResponse } from "node:http";
import { getStats, clearStats } from "../../stats.js";
import type { AuxiliaryRouteContext } from "./context.js";
import { modelsEndpointMeta } from "../upstream-capabilities.js";

function maskSensitiveKey(value: string): string {
  const t = value.trim();
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export async function tryHealthCacheStatsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  if (req.url === "/health" || req.url?.startsWith("/health?")) {
    const url = new URL(req.url!, "http://localhost");
    const full = url.searchParams.get("full") === "true";

    const me = modelsEndpointMeta(ctx.upstreamMode, ctx.options.apiKeyAllowAuxRoutes);
    const response: Record<string, unknown> = {
      status: "ok",
      wallet: ctx.walletAddress,
      paymentChain: ctx.paymentChain,
      upstreamMode: ctx.upstreamMode,
      modelsEndpoint: {
        source: me.source,
        paidBlockRunAuxRoutes: me.paidBlockRunAuxRoutesEnabled,
        auxiliaryHttpRoutesEnabled: me.auxiliaryHttpRoutesEnabled,
        auxiliaryHttpRoutesTransport: me.auxiliaryHttpRoutesTransport,
      },
    };
    if (ctx.upstreamMode === "apiKey") {
      response.upstreamApiBase = ctx.apiBase;
      const k = ctx.options.upstreamApiKey?.trim();
      if (k) response.upstreamApiKey = maskSensitiveKey(k);
    }
    if (ctx.upstreamMode === "moonpay") {
      response.upstreamApiBase = ctx.apiBase;
      const w = ctx.options.moonpayWallet?.trim();
      if (w) response.moonpayWallet = w;
      if (ctx.options.moonpayPaymentChain) {
        response.moonpayPaymentChain = ctx.options.moonpayPaymentChain;
      }
    }
    if (ctx.solanaAddress) {
      response.solana = ctx.solanaAddress;
    }
    if (ctx.upstreamProxy) {
      response.upstreamProxy = ctx.upstreamProxy;
    }

    if (full) {
      try {
        const balanceInfo = await ctx.balanceMonitor.checkBalance();
        response.balance = balanceInfo.balanceUSD;
        response.isLow = balanceInfo.isLow;
        response.isEmpty = balanceInfo.isEmpty;
      } catch {
        response.balanceError = "Could not fetch balance";
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return true;
  }

  if (req.url === "/cache" || req.url?.startsWith("/cache?")) {
    const stats = ctx.responseCache.getStats();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify(stats, null, 2));
    return true;
  }

  if (req.url === "/stats" && req.method === "DELETE") {
    try {
      const result = await clearStats();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cleared: true, deletedFiles: result.deletedFiles }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Failed to clear stats: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
    return true;
  }

  if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
    try {
      const url = new URL(req.url!, "http://localhost");
      const days = parseInt(url.searchParams.get("days") || "7", 10);
      const stats = await getStats(Math.min(days, 30));

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      });
      res.end(
        JSON.stringify(
          {
            ...stats,
            providerErrors: Object.fromEntries(ctx.perProviderErrors),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
    return true;
  }

  return false;
}
