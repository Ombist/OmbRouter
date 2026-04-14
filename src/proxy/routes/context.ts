import type { ResponseCache } from "../../response-cache.js";
import type { AnyBalanceMonitor, PayFetchFn } from "../chat-request-context.js";
import type { ProxyOptions } from "../../proxy.js";
import type { ProviderErrorCounts } from "../chat/fallback-state.js";
import type { UpstreamMode } from "../upstream-transport.js";

export type { ProviderErrorCounts };

export type AuxiliaryRouteContext = {
  walletAddress: string;
  solanaAddress: string | undefined;
  paymentChain: string | undefined;
  upstreamMode: UpstreamMode;
  upstreamProxy: string | undefined;
  balanceMonitor: AnyBalanceMonitor;
  responseCache: ResponseCache;
  perProviderErrors: Map<string, ProviderErrorCounts>;
  apiBase: string;
  payFetch: PayFetchFn;
  options: ProxyOptions;
  getListenPort: () => number;
  imageDir: string;
  audioDir: string;
};
