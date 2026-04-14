import type { RouterOptions } from "../router/index.js";
import type { RequestDeduplicator } from "../dedup.js";
import type { ResponseCache } from "../response-cache.js";
import type { SessionStore } from "../session.js";
import type { SessionJournal } from "../journal.js";
import type { BalanceMonitor } from "../balance.js";
import type { SolanaBalanceMonitor } from "../solana-balance.js";
import type { ApiKeyBalanceMonitor } from "../api-key-balance-monitor.js";
import type { MoonPayBalanceMonitor } from "../moonpay-balance-monitor.js";
import type { ProxyOptions } from "../proxy.js";
import type { UpstreamMode } from "./upstream-transport.js";
import type { EstimateAmountFn } from "./estimate-amount.js";

export type AnyBalanceMonitor =
  | BalanceMonitor
  | SolanaBalanceMonitor
  | ApiKeyBalanceMonitor
  | MoonPayBalanceMonitor;

export type PayFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Dependencies for chat completions proxying (single object to avoid long parameter lists).
 */
export type ProxyRequestContext = {
  apiBase: string;
  payFetch: PayFetchFn;
  options: ProxyOptions;
  routerOpts: RouterOptions;
  deduplicator: RequestDeduplicator;
  balanceMonitor: AnyBalanceMonitor;
  sessionStore: SessionStore;
  responseCache: ResponseCache;
  sessionJournal: SessionJournal;
  upstreamMode: UpstreamMode;
  /** Per-request cost estimate using merged model pricing (incl. cost_config). */
  estimateAmount: EstimateAmountFn;
};
