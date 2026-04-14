/**
 * Local x402 Proxy Server
 *
 * Sits between OpenClaw's pi-ai (which makes standard OpenAI-format requests)
 * and BlockRun's API (which requires x402 micropayments).
 *
 * Flow:
 *   pi-ai → http://localhost:{port}/v1/chat/completions
 *        → proxy forwards to https://blockrun.ai/api/v1/chat/completions
 *        → gets 402 → @x402/fetch signs payment → retries
 *        → streams response back to pi-ai
 *
 * Optimizations (v0.3.0):
 *   - SSE heartbeat: for streaming requests, sends headers + heartbeat immediately
 *     before the x402 flow, preventing OpenClaw's 10-15s timeout from firing.
 *   - Response dedup: hashes request bodies and caches responses for 30s,
 *     preventing double-charging when OpenClaw retries after timeout.
 *   - Smart routing: when model is "blockrun/auto", classify query and pick cheapest model.
 *   - Usage logging: log every request as JSON line to ~/.openclaw/blockrun/logs/
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { paymentStore } from "./proxy/payment-context.js";
import { tryHandleAuxiliaryRoutes } from "./proxy/route-handlers.js";
import {
  categorizeError,
  detectDegradedSuccessResponse,
  type ErrorCategory,
} from "./proxy/provider-errors.js";
import { finished } from "node:stream";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { createPayFetchWithPreAuth } from "./payment-preauth.js";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import {
  DEFAULT_ROUTING_CONFIG,
  type RouterOptions,
  type RoutingDecision,
  type RoutingConfig,
} from "./router/index.js";
import { RequestDeduplicator } from "./dedup.js";
import { ResponseCache, type ResponseCacheConfig } from "./response-cache.js";
import { BalanceMonitor } from "./balance.js";
import type { SolanaBalanceMonitor } from "./solana-balance.js";
import type { UpstreamMode } from "./proxy/upstream-transport.js";
import { createApiKeyPayFetch } from "./proxy/upstream-transport.js";
import { ApiKeyBalanceMonitor } from "./api-key-balance-monitor.js";
import { MoonPayBalanceMonitor } from "./moonpay-balance-monitor.js";
import {
  createMoonPayCliPayFetch,
  type MoonPayChain,
} from "./proxy/moonpay-upstream-transport.js";
import { resolvePaymentChain } from "./auth.js";
import { SessionStore, type SessionConfig } from "./session.js";
import { checkForUpdates } from "./updater.js";
import { PROXY_PORT } from "./config.js";
import { SessionJournal } from "./journal.js";
import { applyUpstreamProxy } from "./upstream-proxy.js";
import {
  buildEffectiveModelPricing,
  loadCostConfigPayload,
  resolveCostConfigPath,
} from "./pricing/cost-config.js";
import { createEstimateAmount } from "./proxy/estimate-amount.js";
import { perProviderErrors } from "./proxy/chat/fallback-state.js";
import { proxyRequest } from "./proxy/chat/completions.js";
import { transformPaymentError } from "./proxy/transform-payment-error.js";
import type { PayFetchFn } from "./proxy/chat-request-context.js";

/** Union type for chain-agnostic balance monitoring */
type AnyBalanceMonitor =
  | BalanceMonitor
  | SolanaBalanceMonitor
  | ApiKeyBalanceMonitor
  | MoonPayBalanceMonitor;

const BLOCKRUN_API = "https://blockrun.ai/api";
const BLOCKRUN_SOLANA_API = "https://sol.blockrun.ai/api";
const IMAGE_DIR = join(homedir(), ".openclaw", "blockrun", "images");
const AUDIO_DIR = join(homedir(), ".openclaw", "blockrun", "audio");
const HEALTH_CHECK_TIMEOUT_MS = 2_000; // Timeout for checking existing proxy
const PORT_RETRY_ATTEMPTS = 5; // Max attempts to bind port (handles TIME_WAIT)
const PORT_RETRY_DELAY_MS = 1_000; // Delay between retry attempts

export { transformPaymentError };

/**
 * Get the proxy port from pre-loaded configuration.
 * Port is validated at module load time, this just returns the cached value.
 */
export function getProxyPort(): number {
  return PROXY_PORT;
}

/**
 * Check if a proxy is already running on the given port.
 * Returns the wallet address if running, undefined otherwise.
 */
async function checkExistingProxy(
  port: number,
): Promise<{ wallet: string; paymentChain?: string; upstreamMode?: UpstreamMode } | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as {
        status?: string;
        wallet?: string;
        paymentChain?: string;
        upstreamMode?: UpstreamMode;
      };
      if (data.status !== "ok") return undefined;
      const mode = data.upstreamMode ?? "x402";
      if (mode === "apiKey" || mode === "moonpay") {
        return {
          wallet: data.wallet ?? "",
          paymentChain: data.paymentChain,
          upstreamMode: mode,
        };
      }
      if (data.wallet) {
        return { wallet: data.wallet, paymentChain: data.paymentChain, upstreamMode: "x402" };
      }
    }
    return undefined;
  } catch {
    clearTimeout(timeoutId);
    return undefined;
  }
}

/** Callback info for low balance warning */
export type LowBalanceInfo = {
  balanceUSD: string;
  walletAddress: string;
};

/** Callback info for insufficient funds error */
export type InsufficientFundsInfo = {
  balanceUSD: string;
  requiredUSD: string;
  walletAddress: string;
};

/**
 * Wallet config: either a plain EVM private key string, or the full
 * resolution object from resolveOrGenerateWalletKey() which may include
 * Solana keys. Using the full object prevents callers from accidentally
 * forgetting to forward Solana key bytes.
 */
export type WalletConfig = string | { key: string; solanaPrivateKeyBytes?: Uint8Array };

export type PaymentChain = "base" | "solana";

export type ProxyOptions = {
  /**
   * Upstream transport. Default `x402` (BlockRun + wallet). Use `apiKey` for OpenAI-compatible APIs.
   * Use `moonpay` to delegate paid HTTPS calls to MoonPay CLI (`mp x402 request`).
   */
  upstreamMode?: UpstreamMode;
  /** Required when `upstreamMode` is `apiKey`. Sent as `Authorization: Bearer …`. */
  upstreamApiKey?: string;
  /**
   * When `upstreamMode` is `apiKey`, forward `/v1/images/*`, `/v1/audio/generations`, and partner
   * paths to `apiBase` with Bearer auth (instead of 501). Default: false unless env
   * `OMBROUTER_APIKEY_AUX_ROUTES` is true/1/yes.
   */
  apiKeyAllowAuxRoutes?: boolean;
  /** Required when `upstreamMode` is `moonpay`. Local MoonPay CLI wallet name (`mp wallet list`). */
  moonpayWallet?: string;
  /** Chain for x402 payment when using `moonpay` (default: base). */
  moonpayPaymentChain?: MoonPayChain;
  /** Path to `mp` binary (default: `mp` on PATH). */
  moonpayCliPath?: string;
  /**
   * EVM key and optional Solana bytes. Required when `upstreamMode` is `x402` (default).
   */
  wallet?: WalletConfig;
  apiBase?: string;
  /** Payment chain: "base" (default) or "solana". Env: `OMBROUTER_PAYMENT_CHAIN`. */
  paymentChain?: PaymentChain;
  /** Port to listen on (default: 8402) */
  port?: number;
  routingConfig?: Partial<RoutingConfig>;
  /** Request timeout in ms (default: 180000 = 3 minutes). Covers on-chain tx + LLM response. */
  requestTimeoutMs?: number;
  /** Skip balance checks (for testing only). Default: false */
  skipBalanceCheck?: boolean;
  /** Override the balance monitor with a mock (for testing only). */
  _balanceMonitorOverride?: AnyBalanceMonitor;
  /**
   * When `upstreamMode` is `moonpay`, use this instead of spawning `mp` (tests only).
   */
  _payFetchOverride?: PayFetchFn;
  /**
   * Session persistence config. When enabled, maintains model selection
   * across requests within a session to prevent mid-task model switching.
   */
  sessionConfig?: Partial<SessionConfig>;
  /**
   * Auto-compress large requests to reduce network usage.
   * When enabled, requests are automatically compressed using
   * LLM-safe context compression (15-40% reduction).
   * Default: true
   */
  autoCompressRequests?: boolean;
  /**
   * Threshold in KB to trigger auto-compression (default: 180).
   * Requests larger than this are compressed before sending.
   * Set to 0 to compress all requests.
   */
  compressionThresholdKB?: number;
  /**
   * Response caching config. When enabled, identical requests return
   * cached responses instead of making new API calls.
   * Default: enabled with 10 minute TTL, 200 max entries.
   */
  cacheConfig?: ResponseCacheConfig;
  /**
   * Maximum total spend (in USD) per session run.
   * Default: undefined (no limit). Example: 0.5 = $0.50 per session.
   */
  maxCostPerRunUsd?: number;
  /**
   * How to enforce the per-run cost cap.
   * - 'graceful' (default): when budget runs low, downgrade to cheaper models; use free model
   *   as last resort. Only hard-stops when no model can serve the request.
   * - 'strict': immediately return 429 once the session spend reaches the cap.
   */
  maxCostPerRunMode?: "graceful" | "strict";
  /**
   * Hard cap on total input+output tokens per session (after prep phase session id is known).
   * When exceeded, returns 429. Default: unlimited.
   */
  maxTokensPerSession?: number;
  /**
   * When true, per-session USD cap (`maxCostPerRunUsd`) also applies to free-tier models
   * and their usage is counted toward the cap. Default: false.
   */
  quotaIncludeFreeInUsdCap?: boolean;
  /**
   * Set of model IDs to exclude from routing.
   * Excluded models are filtered out of fallback chains.
   * Loaded from ~/.openclaw/blockrun/exclude-models.json
   */
  excludeModels?: Set<string>;
  /**
   * Optional path to cost_config.json (per-model price overrides).
   * Default: OMBROUTER_COST_CONFIG env, else ~/.openclaw/blockrun/cost_config.json
   */
  costConfigPath?: string;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onPayment?: (info: { model: string; amount: string; network: string }) => void;
  onRouted?: (decision: RoutingDecision) => void;
  /** Called when balance drops below $1.00 (warning, request still proceeds) */
  onLowBalance?: (info: LowBalanceInfo) => void;
  /** Called when balance is insufficient for a request (request fails) */
  onInsufficientFunds?: (info: InsufficientFundsInfo) => void;
  /**
   * Upstream proxy URL for all outgoing requests.
   * Supports http://, https://, and socks5:// schemes.
   * Also readable via BLOCKRUN_UPSTREAM_PROXY environment variable.
   * Example: "socks5://127.0.0.1:1080"
   */
  upstreamProxy?: string;
  /**
   * Per-request trace id: echo on responses, forward upstream, prefix logs.
   * Default: enabled with `x-request-id` and `request_id` on JSON errors.
   */
  requestTrace?: {
    /** When false, still logs with an internal id but omits the response header. Default true. */
    enabled?: boolean;
    /** Response header name (lowercased when sent). Default `x-request-id`. */
    responseHeader?: string;
    /** Add `request_id` inside JSON error bodies. Default true. */
    includeInErrorBody?: boolean;
  };
};

export type ProxyHandle = {
  port: number;
  baseUrl: string;
  walletAddress: string;
  solanaAddress?: string;
  balanceMonitor: AnyBalanceMonitor;
  upstreamMode: UpstreamMode;
  close: () => Promise<void>;
};

/**
 * Merge partial routing config overrides with defaults.
 */
function mergeRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides },
  };
}

/**
 * Start the local x402 proxy server.
 *
 * If a proxy is already running on the target port, reuses it instead of failing.
 * Port can be configured via BLOCKRUN_PROXY_PORT environment variable.
 *
 * Returns a handle with the assigned port, base URL, and a close function.
 */
function resolveApiKeyAllowAuxRoutes(options: ProxyOptions): boolean {
  if (options.apiKeyAllowAuxRoutes === true) return true;
  if (options.apiKeyAllowAuxRoutes === false) return false;
  const v = process.env.OMBROUTER_APIKEY_AUX_ROUTES?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const upstreamMode: UpstreamMode = options.upstreamMode ?? "x402";

  if (upstreamMode === "apiKey") {
    if (!options.upstreamApiKey?.trim()) {
      throw new Error('OmbRouter: upstreamApiKey is required when upstreamMode is "apiKey"');
    }
    if (!options.apiBase?.trim()) {
      throw new Error(
        'OmbRouter: apiBase is required when upstreamMode is "apiKey" (e.g. https://api.openai.com/v1)',
      );
    }
    options.apiKeyAllowAuxRoutes = resolveApiKeyAllowAuxRoutes(options);
  } else if (upstreamMode === "moonpay") {
    if (!options.moonpayWallet?.trim()) {
      throw new Error('OmbRouter: moonpayWallet is required when upstreamMode is "moonpay"');
    }
  } else if (options.wallet === undefined) {
    throw new Error('OmbRouter: wallet is required when upstreamMode is "x402"');
  }

  // Apply upstream proxy (SOCKS5/HTTP) before any outgoing requests
  const upstreamProxy = await applyUpstreamProxy(options.upstreamProxy);
  if (upstreamProxy) {
    console.log(`[OmbRouter] Upstream proxy: ${upstreamProxy}`);
  }

  // Determine port: options.port > env var > default
  const listenPort = options.port ?? getProxyPort();

  // Check if a proxy is already running on this port
  const existingProxy = await checkExistingProxy(listenPort);
  if (existingProxy) {
    const existingMode = existingProxy.upstreamMode ?? "x402";
    if (existingMode !== upstreamMode) {
      throw new Error(
        `Existing proxy on port ${listenPort} uses upstreamMode "${existingMode}" but "${upstreamMode}" was requested. ` +
          `Stop the existing proxy first or use a different port.`,
      );
    }

    const baseUrl = `http://127.0.0.1:${listenPort}`;

    if (upstreamMode === "apiKey") {
      options.onReady?.(listenPort);
      return {
        port: listenPort,
        baseUrl,
        walletAddress: existingProxy.wallet || "",
        solanaAddress: undefined,
        balanceMonitor: new ApiKeyBalanceMonitor(),
        upstreamMode,
        close: async () => {
          /* no-op: reused instance */
        },
      };
    }

    if (upstreamMode === "moonpay") {
      const label =
        options.moonpayWallet?.trim() ||
        existingProxy.wallet.replace(/^moonpay:/, "") ||
        "default";
      options.onReady?.(listenPort);
      return {
        port: listenPort,
        baseUrl,
        walletAddress: existingProxy.wallet || `moonpay:${label}`,
        solanaAddress: undefined,
        balanceMonitor: new MoonPayBalanceMonitor(label),
        upstreamMode,
        close: async () => {},
      };
    }

    const walletKey =
      typeof options.wallet === "string" ? options.wallet : options.wallet!.key;
    const solanaPrivateKeyBytes =
      typeof options.wallet === "string" ? undefined : options.wallet!.solanaPrivateKeyBytes;

    const paymentChain = options.paymentChain ?? (await resolvePaymentChain());
    const account = privateKeyToAccount(walletKey as `0x${string}`);

    if (existingProxy.wallet !== account.address) {
      console.warn(
        `[OmbRouter] Existing proxy on port ${listenPort} uses wallet ${existingProxy.wallet}, but current config uses ${account.address}. Reusing existing proxy.`,
      );
    }

    if (existingProxy.paymentChain) {
      if (existingProxy.paymentChain !== paymentChain) {
        throw new Error(
          `Existing proxy on port ${listenPort} is using ${existingProxy.paymentChain} but ${paymentChain} was requested. ` +
            `Stop the existing proxy first or use a different port.`,
        );
      }
    } else if (paymentChain !== "base") {
      console.warn(
        `[OmbRouter] Existing proxy on port ${listenPort} does not report paymentChain (pre-v0.11 instance). Assuming Base.`,
      );
      throw new Error(
        `Existing proxy on port ${listenPort} is a pre-v0.11 instance (assumed Base) but ${paymentChain} was requested. ` +
          `Stop the existing proxy first or use a different port.`,
      );
    }

    let reuseSolanaAddress: string | undefined;
    if (solanaPrivateKeyBytes) {
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
      reuseSolanaAddress = solanaSigner.address;
    }

    let balanceMonitorReuse: AnyBalanceMonitor;
    if (paymentChain === "solana" && reuseSolanaAddress) {
      const { SolanaBalanceMonitor } = await import("./solana-balance.js");
      balanceMonitorReuse = new SolanaBalanceMonitor(reuseSolanaAddress);
    } else {
      balanceMonitorReuse = new BalanceMonitor(account.address);
    }

    options.onReady?.(listenPort);

    return {
      port: listenPort,
      baseUrl,
      walletAddress: existingProxy.wallet,
      solanaAddress: reuseSolanaAddress,
      balanceMonitor: balanceMonitorReuse,
      upstreamMode,
      close: async () => {
        // No-op: we didn't start this proxy, so we shouldn't close it
      },
    };
  }

  // --- New process: build transport + apiBase for this instance ---
  let payFetch: PayFetchFn;
  let balanceMonitor: AnyBalanceMonitor;
  let apiBase: string;
  let paymentChain: PaymentChain;
  let walletAddressForCtx: string;
  let solanaAddress: string | undefined;

  if (upstreamMode === "apiKey") {
    apiBase = options.apiBase!.trim();
    paymentChain = options.paymentChain ?? "base";
    payFetch = createApiKeyPayFetch(options.upstreamApiKey!, fetch);
    balanceMonitor = options._balanceMonitorOverride ?? new ApiKeyBalanceMonitor();
    walletAddressForCtx = "";
    solanaAddress = undefined;
    console.log(
      `[OmbRouter] Upstream mode: apiKey (base ${apiBase})${options.apiKeyAllowAuxRoutes ? "; auxiliary routes → Bearer" : ""}`,
    );
  } else if (upstreamMode === "moonpay") {
    apiBase = (options.apiBase?.trim() || BLOCKRUN_API).replace(/\/$/, "");
    paymentChain = options.paymentChain ?? "base";
    const mpChain = options.moonpayPaymentChain ?? "base";
    payFetch =
      options._payFetchOverride ??
      createMoonPayCliPayFetch(
        {
          wallet: options.moonpayWallet!.trim(),
          chain: mpChain,
          mpPath: options.moonpayCliPath,
        },
        fetch,
      );
    balanceMonitor =
      options._balanceMonitorOverride ?? new MoonPayBalanceMonitor(options.moonpayWallet!.trim());
    walletAddressForCtx = `moonpay:${options.moonpayWallet!.trim()}`;
    solanaAddress = undefined;
    console.log(`[OmbRouter] Upstream mode: moonpay (wallet ${options.moonpayWallet}, chain ${mpChain}, api ${apiBase})`);
  } else {
    const walletKey =
      typeof options.wallet === "string" ? options.wallet : options.wallet!.key;
    const solanaPrivateKeyBytes =
      typeof options.wallet === "string" ? undefined : options.wallet!.solanaPrivateKeyBytes;

    paymentChain = options.paymentChain ?? (await resolvePaymentChain());
    apiBase =
      options.apiBase ??
      (paymentChain === "solana" && solanaPrivateKeyBytes ? BLOCKRUN_SOLANA_API : BLOCKRUN_API);
    if (paymentChain === "solana" && !solanaPrivateKeyBytes) {
      console.warn(
        `[OmbRouter] ⚠ Payment chain is Solana but no mnemonic found — falling back to Base (EVM).`,
      );
      console.warn(`[OmbRouter]   To fix: run "ombrouter wallet recover" if your mnemonic exists,`);
      console.warn(`[OmbRouter]   or run "ombrouter chain base" to switch to EVM.`);
    } else if (paymentChain === "solana") {
      console.log(`[OmbRouter] Payment chain: Solana (${BLOCKRUN_SOLANA_API})`);
    }

    // Create x402 payment client with EVM scheme (always available)
    const account = privateKeyToAccount(walletKey as `0x${string}`);
    const evmPublicClient = createPublicClient({ chain: base, transport: http() });
    const evmSigner = toClientEvmSigner(account, evmPublicClient);
    const x402 = new x402Client();
    registerExactEvmScheme(x402, { signer: evmSigner });

    solanaAddress = undefined;
    if (solanaPrivateKeyBytes) {
      const { registerExactSvmScheme } = await import("@x402/svm/exact/client");
      const { createKeyPairSignerFromPrivateKeyBytes } = await import("@solana/kit");
      const solanaSigner = await createKeyPairSignerFromPrivateKeyBytes(solanaPrivateKeyBytes);
      solanaAddress = solanaSigner.address;
      registerExactSvmScheme(x402, { signer: solanaSigner });
      console.log(`[OmbRouter] Solana wallet: ${solanaAddress}`);
    }

    x402.onAfterPaymentCreation(async (context) => {
      const network = context.selectedRequirements.network;
      const chain = network.startsWith("eip155")
        ? "Base (EVM)"
        : network.startsWith("solana")
          ? "Solana"
          : network;
      const amountMicros = parseInt(context.selectedRequirements.amount || "0", 10);
      const amountUsd = amountMicros / 1_000_000;
      const store = paymentStore.getStore();
      if (store) store.amountUsd = amountUsd;
      console.log(`[OmbRouter] Payment signed on ${chain} (${network}) — $${amountUsd.toFixed(6)}`);
    });

    payFetch = createPayFetchWithPreAuth(fetch, x402, undefined, {
      skipPreAuth: paymentChain === "solana",
    });

    if (options._balanceMonitorOverride) {
      balanceMonitor = options._balanceMonitorOverride;
    } else if (paymentChain === "solana" && solanaAddress) {
      const { SolanaBalanceMonitor } = await import("./solana-balance.js");
      balanceMonitor = new SolanaBalanceMonitor(solanaAddress);
    } else {
      balanceMonitor = new BalanceMonitor(account.address);
    }

    walletAddressForCtx = account.address;
  }

  // Build router options (100% local — no external API calls for routing)
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const costConfigResolvedPath = resolveCostConfigPath({ costConfigPath: options.costConfigPath });
  const { raw: costConfigRaw } = loadCostConfigPayload(costConfigResolvedPath);
  const modelPricing = buildEffectiveModelPricing(costConfigRaw, (msg) => console.warn(msg));
  const estimateAmountFn = createEstimateAmount(modelPricing);
  if (costConfigRaw?.models && Object.keys(costConfigRaw.models).length > 0) {
    console.log(`[OmbRouter] Loaded cost overrides from ${costConfigResolvedPath}`);
  }
  const routerOpts: RouterOptions = {
    config: routingConfig,
    modelPricing,
  };

  // Request deduplicator (shared across all requests)
  const deduplicator = new RequestDeduplicator();

  // Response cache for identical requests (longer TTL than dedup)
  const responseCache = new ResponseCache(options.cacheConfig);

  // Session store for model persistence (prevents mid-task model switching)
  const sessionStore = new SessionStore(options.sessionConfig);

  // Session journal for memory (enables agents to recall earlier work)
  const sessionJournal = new SessionJournal();

  // Track active connections for graceful cleanup
  const connections = new Set<import("net").Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Wrap in paymentStore.run() so x402 hook can write actual payment amount per-request
    paymentStore.run({ amountUsd: 0 }, async () => {
      // Add stream error handlers to prevent server crashes
      req.on("error", (err) => {
        console.error(`[OmbRouter] Request stream error: ${err.message}`);
        // Don't throw - just log and let request handler deal with it
      });

      res.on("error", (err) => {
        console.error(`[OmbRouter] Response stream error: ${err.message}`);
        // Don't try to write to failed socket - just log
      });

      // Finished wrapper for guaranteed cleanup on response completion/error
      finished(res, (err) => {
        if (err && err.code !== "ERR_STREAM_DESTROYED") {
          console.error(`[OmbRouter] Response finished with error: ${err.message}`);
        }
        // Note: heartbeatInterval cleanup happens in res.on("close") handler
        // Note: completed and dedup cleanup happens in the res.on("close") handler below
      });

      // Request finished wrapper for complete stream lifecycle tracking
      finished(req, (err) => {
        if (err && err.code !== "ERR_STREAM_DESTROYED") {
          console.error(`[OmbRouter] Request finished with error: ${err.message}`);
        }
      });

      if (
        await tryHandleAuxiliaryRoutes(req, res, {
          walletAddress: walletAddressForCtx,
          solanaAddress,
          paymentChain,
          upstreamMode,
          upstreamProxy,
          balanceMonitor,
          responseCache,
          perProviderErrors,
          apiBase,
          payFetch,
          options,
          getListenPort: () => (server.address() as AddressInfo | null)?.port ?? getProxyPort(),
          imageDir: IMAGE_DIR,
          audioDir: AUDIO_DIR,
        })
      ) {
        return;
      }

      try {
        await proxyRequest(req, res, {
          apiBase,
          payFetch,
          options,
          routerOpts,
          deduplicator,
          balanceMonitor,
          sessionStore,
          responseCache,
          sessionJournal,
          upstreamMode,
          estimateAmount: estimateAmountFn,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);

        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `Proxy error: ${error.message}`, type: "proxy_error" },
            }),
          );
        } else if (!res.writableEnded) {
          // Headers already sent (streaming) — send error as SSE event
          res.write(
            `data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }
    }); // end paymentStore.run()
  });

  // Listen on configured port with retry logic for TIME_WAIT handling
  // When gateway restarts quickly, the port may still be in TIME_WAIT state.
  // We retry with delay instead of incorrectly assuming a proxy is running.
  const tryListen = (attempt: number): Promise<void> => {
    return new Promise<void>((resolveAttempt, rejectAttempt) => {
      const onError = async (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);

        if (err.code === "EADDRINUSE") {
          // Port is in use - check if a proxy is actually running
          const existingProxy2 = await checkExistingProxy(listenPort);
          if (existingProxy2) {
            // Proxy is actually running - this is fine, reuse it
            console.log(`[OmbRouter] Existing proxy detected on port ${listenPort}, reusing`);
            rejectAttempt({
              code: "REUSE_EXISTING",
              wallet: existingProxy2.wallet,
              existingChain: existingProxy2.paymentChain,
              existingUpstreamMode: existingProxy2.upstreamMode ?? "x402",
            });
            return;
          }

          // Port is in TIME_WAIT (no proxy responding) - retry after delay
          if (attempt < PORT_RETRY_ATTEMPTS) {
            console.log(
              `[OmbRouter] Port ${listenPort} in TIME_WAIT, retrying in ${PORT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PORT_RETRY_ATTEMPTS})`,
            );
            rejectAttempt({ code: "RETRY", attempt });
            return;
          }

          // Max retries exceeded
          console.error(
            `[OmbRouter] Port ${listenPort} still in use after ${PORT_RETRY_ATTEMPTS} attempts`,
          );
          rejectAttempt(err);
          return;
        }

        rejectAttempt(err);
      };

      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveAttempt();
      });
    });
  };

  // Retry loop for port binding
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await tryListen(attempt);
      break; // Success
    } catch (err: unknown) {
      const error = err as {
        code?: string;
        wallet?: string;
        existingChain?: string;
        existingUpstreamMode?: UpstreamMode;
        attempt?: number;
      };

      if (
        error.code === "REUSE_EXISTING" &&
        (error.existingUpstreamMode === "apiKey" ||
          error.existingUpstreamMode === "moonpay" ||
          error.wallet)
      ) {
        const reusedMode = error.existingUpstreamMode ?? "x402";
        if (reusedMode !== upstreamMode) {
          throw new Error(
            `Existing proxy on port ${listenPort} uses upstreamMode "${reusedMode}" but "${upstreamMode}" was requested.`,
            { cause: err },
          );
        }

        if (reusedMode === "apiKey") {
          const baseUrl = `http://127.0.0.1:${listenPort}`;
          options.onReady?.(listenPort);
          return {
            port: listenPort,
            baseUrl,
            walletAddress: error.wallet ?? "",
            solanaAddress: undefined,
            balanceMonitor: new ApiKeyBalanceMonitor(),
            upstreamMode,
            close: async () => {},
          };
        }

        if (reusedMode === "moonpay") {
          const label =
            options.moonpayWallet?.trim() ?? error.wallet?.replace(/^moonpay:/, "") ?? "default";
          const baseUrl = `http://127.0.0.1:${listenPort}`;
          options.onReady?.(listenPort);
          return {
            port: listenPort,
            baseUrl,
            walletAddress: error.wallet ?? `moonpay:${label}`,
            solanaAddress: undefined,
            balanceMonitor: new MoonPayBalanceMonitor(label),
            upstreamMode,
            close: async () => {},
          };
        }

        if (error.existingChain && error.existingChain !== paymentChain) {
          throw new Error(
            `Existing proxy on port ${listenPort} is using ${error.existingChain} but ${paymentChain} was requested. ` +
              `Stop the existing proxy first or use a different port.`,
            { cause: err },
          );
        }

        const baseUrl = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        return {
          port: listenPort,
          baseUrl,
          walletAddress: error.wallet!,
          solanaAddress,
          balanceMonitor,
          upstreamMode,
          close: async () => {},
        };
      }

      if (error.code === "RETRY") {
        // Wait before retry
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }

      // Other error - throw
      lastError = err as Error;
      break;
    }
  }

  if (lastError) {
    throw lastError;
  }

  // Server is now listening - set up remaining handlers
  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  options.onReady?.(port);

  // Check for updates (non-blocking)
  checkForUpdates();

  // Add runtime error handler AFTER successful listen
  // This handles errors that occur during server operation (not just startup)
  server.on("error", (err) => {
    console.error(`[OmbRouter] Server runtime error: ${err.message}`);
    options.onError?.(err);
    // Don't crash - log and continue
  });

  // Handle client connection errors (bad requests, socket errors)
  server.on("clientError", (err, socket) => {
    console.error(`[OmbRouter] Client error: ${err.message}`);
    // Send 400 Bad Request if socket is still writable
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  // Track connections for graceful cleanup
  server.on("connection", (socket) => {
    connections.add(socket);

    // Set 5-minute timeout for streaming requests
    socket.setTimeout(300_000);

    socket.on("timeout", () => {
      console.error(`[OmbRouter] Socket timeout, destroying connection`);
      socket.destroy();
    });

    socket.on("end", () => {
      // Half-closed by client (FIN received)
    });

    socket.on("error", (err) => {
      console.error(`[OmbRouter] Socket error: ${err.message}`);
    });

    socket.on("close", () => {
      connections.delete(socket);
    });
  });

  return {
    port,
    baseUrl,
    walletAddress: walletAddressForCtx,
    solanaAddress,
    balanceMonitor,
    upstreamMode,
    close: () =>
      new Promise<void>((res, rej) => {
        const timeout = setTimeout(() => {
          rej(new Error("[OmbRouter] Close timeout after 4s"));
        }, 4000);

        sessionStore.close();
        // Destroy all active connections before closing server
        for (const socket of connections) {
          socket.destroy();
        }
        connections.clear();
        server.close((err) => {
          clearTimeout(timeout);
          if (err) {
            rej(err);
          } else {
            res();
          }
        });
      }),
  };
}

export { buildProxyModelList } from "./proxy/model-list.js";
export { categorizeError, detectDegradedSuccessResponse, type ErrorCategory };
export { debrandSystemMessages } from "./proxy/debrand-messages.js";
export { normalizeMessagesForThinking } from "./proxy/thinking-messages.js";
