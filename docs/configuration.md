# Configuration Reference

Complete reference for OmbRouter configuration options.

## Table of Contents

- [Environment Variables](#environment-variables)
- [Cost overrides (cost_config.json)](#cost-overrides-cost_configjson)
- [Dual proxy (apiKey + x402 on two ports)](#dual-proxy-apikey--x402-on-two-ports)
- [Upstream transport (x402, apiKey, moonpay)](#upstream-transport-x402-apikey-moonpay)
- [Wallet Configuration](#wallet-configuration)
- [Wallet Backup & Recovery](#wallet-backup--recovery)
- [Proxy Settings](#proxy-settings)
- [Programmatic Usage](#programmatic-usage)
- [Routing Configuration](#routing-configuration)
- [Tier Overrides](#tier-overrides)
- [Scoring Weights](#scoring-weights)
- [Testing Configuration](#testing-configuration)

---

## Environment Variables

| Variable                    | Default                               | Description                                                              |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| `BLOCKRUN_WALLET_KEY`       | -                                     | Ethereum private key (hex, 0x-prefixed). Used if no saved wallet exists. |
| `BLOCKRUN_PROXY_PORT`       | `8402`                                | Port for the local x402 proxy server.                                    |
| `OMBROUTER_SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC for USDC balance checks.                            |
| `OMBROUTER_DISABLED`       | `false`                               | Set to `true` to disable smart routing (OpenClaw plugin).                |
| `OMBROUTER_PAYMENT_CHAIN`   | -                                     | `base` or `solana`.                                                     |
| `OMBROUTER_UPSTREAM_MODE`   | `x402`                                | `x402` (BlockRun + local wallet), `apiKey` (Bearer upstream), or `moonpay` (MoonPay CLI `mp x402 request`). |
| `OMBROUTER_UPSTREAM_API_BASE` | -                                   | Required for `apiKey`. Optional for `moonpay` (HTTPS x402 API base; default BlockRun). Ignored for plain `x402` unless overriding API host. |
| `OMBROUTER_UPSTREAM_API_KEY` | -                                    | Required for `apiKey` mode: secret API key (never commit or log).        |
| `OMBROUTER_APIKEY_AUX_ROUTES` | -                                   | Optional for `apiKey`: `true` / `1` / `yes` — forward `/v1/images/*`, `/v1/audio/generations`, and partner paths to `upstreamApiBase` with Bearer (default: off). |
| `OMBROUTER_MOONPAY_WALLET`  | -                                     | Required for `moonpay` mode (unless set in plugin config): wallet name from `mp wallet list`. |
| `OMBROUTER_COST_CONFIG`     | -                                     | Optional absolute path to `cost_config.json` (per-model price overrides). Overrides default `~/.openclaw/blockrun/cost_config.json`. |

OpenClaw plugin **`id`** is **`ombrouter`** (v1.0+). Migrating from v0.12? Run `node scripts/migrate-openclaw-plugin-id.mjs` (see [CHANGELOG](../CHANGELOG.md) v1.0.0).

---

## Cost overrides (cost_config.json)

OmbRouter keeps **per-model token prices** (and optional **flat per-request** promos) in the built-in registry. You can **override** those values locally for **routing estimates**, **x402 balance pre-checks**, **session budget** (`maxCostPerRun`), and the **cost fields** injected into OpenClaw’s model list — without editing source code.

**Resolution order** (first match wins):

1. Plugin config **`costConfigPath`** (OpenClaw `plugins[].config.costConfigPath`)
2. Environment **`OMBROUTER_COST_CONFIG`**
3. Default file **`~/.openclaw/blockrun/cost_config.json`** (same directory family as `exclude-models.json`)

If the file is missing or empty, built-in pricing is used unchanged.

**Format:** JSON with a `models` object. Keys are **model IDs** exactly as in `BLOCKRUN_MODELS` (e.g. `openai/gpt-4o`). Values may include:

| Field | Meaning |
| ----- | ------- |
| `inputPrice` | USD per **1M input tokens** (optional override) |
| `outputPrice` | USD per **1M output tokens** (optional override) |
| `flatPrice` | Fixed **USD per request** — overrides built-in promo flat pricing for that model when set |
| `clearFlatPrice` | When `true`, **removes** flat pricing (promo or prior override) so estimates use token `inputPrice` / `outputPrice` only |

Unknown model IDs log a warning and are ignored. **Actual x402 settlement** still follows the upstream/facilitator; overrides affect **local math and UI** only.

Example `~/.openclaw/blockrun/cost_config.json`:

```json
{
  "models": {
    "openai/gpt-4o": {
      "inputPrice": 2.5,
      "outputPrice": 10.0
    },
    "anthropic/claude-sonnet-4.6": {
      "inputPrice": 3.0,
      "outputPrice": 15.0
    }
  }
}
```

OpenClaw’s `openclaw.json` stores a **`_ombrouterCostRevision`** field on `models.providers.blockrun` (SHA-256 of the config file bytes) so the gateway **refreshes** injected model costs when you edit `cost_config.json`.

---

## Dual proxy (apiKey + x402 on two ports)

To use **`apiKey`** for chat while still calling **image, audio, and partner** routes (which require x402 on the wire), run **two** OmbRouter processes on **different ports** — one `apiKey`, one `x402` or `moonpay`. Set **`BLOCKRUN_PROXY_PORT`** per process; point OpenClaw at the apiKey port for `models.providers.blockrun`. See the full runbook: **[dual-proxy-deployment.md](./dual-proxy-deployment.md)** (includes [scripts/dual-proxy-example.env](../scripts/dual-proxy-example.env), [scripts/verify-dual-proxy.sh](../scripts/verify-dual-proxy.sh), and optional **[scripts/systemd/](../scripts/systemd/README.md)** user units).

---

## Upstream transport (x402, apiKey, moonpay)

| Mode     | Auth / payment | When to use |
| -------- | -------------- | ----------- |
| **`x402`** (default) | EVM/Solana wallet + USDC micropayments via BlockRun (`BLOCKRUN_WALLET_KEY` or saved file) | Agent-native flows when OmbRouter holds signing keys. |
| **`apiKey`** | `Authorization: Bearer …` to an OpenAI-compatible API | Bring your own API key; local routing and quotas still apply. |
| **`moonpay`** | MoonPay Agent CLI signs x402: OmbRouter runs `mp --json x402 request` per paid HTTPS call | Prefer when keys stay in MoonPay CLI / OS keychain — **no `0x` private key in OmbRouter**. |

**OpenClaw plugin config** (`openclaw.plugin.json` / OpenClaw settings):

- `upstreamMode`: `"x402"` | `"apiKey"` | `"moonpay"`
- `upstreamApiBase`: base URL for the upstream (requests go to `` `${upstreamApiBase}${path}` `` — e.g. `/v1/chat/completions`). For `moonpay`, defaults to BlockRun HTTPS API if omitted.
- `upstreamApiKey`: required for `apiKey`; sensitive — treat like `walletKey`.
- `upstreamApiKeyAllowAuxRoutes`: optional boolean for `apiKey` — when `true`, forward image/audio/partner paths to `upstreamApiBase` with Bearer (same as env `OMBROUTER_APIKEY_AUX_ROUTES`).
- `moonpayWallet`: required for `moonpay` — name from `mp wallet list`.
- `moonpayPaymentChain`: optional for `moonpay` — e.g. `base`, `solana` (default `base`).
- `moonpayCliPath`: optional — path to `mp` (default: `mp` on `PATH`).
- `costConfigPath`: optional — absolute or user-expanded path to `cost_config.json` (see [Cost overrides](#cost-overrides-cost_configjson)).

**MoonPay setup (moonpay mode):**

1. Install the CLI: `npm i -g @moonpay/cli` (or follow [MoonPay Agent](https://agents.moonpay.com) docs).
2. `mp login` and create/select a wallet (`mp wallet create`, `mp wallet list`).
3. Set `upstreamMode` to `moonpay` and `moonpayWallet` to that wallet name.

**MoonPay / CLI limitations:**

- Upstream URLs must be **public HTTPS** (MoonPay CLI rejects localhost / private IPs).
- The CLI returns **buffered JSON**; if the client sends `stream: true`, OmbRouter turns off streaming for `mp`, then **synthesizes** OpenAI-style SSE from the completion JSON so OpenClaw streaming still works (not token-by-token live).

**Standalone CLI** (see `ombrouter --help`):

- `--upstream-mode x402|apiKey|moonpay`
- `--upstream-api-base <url>`
- `--upstream-api-key <key>` (apiKey)
- `--apikey-aux-routes` / `--no-apikey-aux-routes` (apiKey: optional Bearer forward for aux paths)
- `--moonpay-wallet <name>`, `--moonpay-chain <chain>`, `--moonpay-cli <path>` (moonpay)

**Quotas (x402, apiKey, moonpay):**

- `maxCostPerRun` / `maxCostPerRunMode` — USD-style session cap (estimates + accumulation).
- `maxTokensPerSession` — hard cap on recorded input+output tokens per session (after usage is known or estimated).
- `quotaIncludeFreeInUsdCap` — when `true`, free-tier models also count toward the USD cap and graceful filtering.

**`/health`:** always includes `upstreamMode` and **`modelsEndpoint`** (`source`, `paidBlockRunAuxRoutes`, `auxiliaryHttpRoutesEnabled`, `auxiliaryHttpRoutesTransport`). For **`apiKey`**, also `upstreamApiBase` and a **masked** `upstreamApiKey`. For **`moonpay`**, `upstreamApiBase` (if set), `moonpayWallet`, and `moonpayPaymentChain` when configured.

- **`paidBlockRunAuxRoutes`:** `true` only for **x402** / **moonpay** (BlockRun micropayment path for those routes).
- **`auxiliaryHttpRoutesEnabled`:** `true` when image/audio/partner routes are accepted — **x402**, **moonpay**, or **apiKey** with optional Bearer forwarding enabled (see below).
- **`auxiliaryHttpRoutesTransport`:** `x402` | `moonpay` | `bearer` | `null`.

**apiKey mode — auxiliary routes (images, audio, partner):**

- **Default:** Partner (`/v1/x/…`, `/v1/partner/…`), image, and audio routes return **501** (same as before). Chat completions remain fully supported.
- **Optional Bearer forward:** Set plugin **`upstreamApiKeyAllowAuxRoutes`**: `true`, or env **`OMBROUTER_APIKEY_AUX_ROUTES=true`** (or `1` / `yes`), or CLI **`--apikey-aux-routes`** (standalone `ombrouter`). Then those paths are forwarded to **`upstreamApiBase`** with **`Authorization: Bearer …`** (no BlockRun x402). Your upstream must implement the path (e.g. OpenAI exposes `/v1/images/*` on the same base; **`/v1/pm/*`** usually does not exist on `api.openai.com` — expect **404** from the upstream).
- **Security:** Enabling this sends your API key to more endpoints; keep default off unless you trust the upstream for those paths.

**Non-chat routes (`x402` and `moonpay`):**

- **`/v1/images/*`**, **`/v1/audio/generations`**, and **partner** paths (`/v1/x/…`, `/v1/partner/…`, `/v1/pm/…`) are forwarded through `payFetch` to your configured **`apiBase`** (typically BlockRun HTTPS). **`moonpay`** uses the same paths as **`x402`**; payment is signed by MoonPay CLI instead of a local `0x` key.

**`GET /v1/models` (all upstream modes):**

- Model IDs always come from the **local OpenClaw routing registry** (`OPENCLAW_MODELS`) — OmbRouter does **not** call MoonPay or your upstream to build this list. Use your provider’s own `/v1/models` if you need their live catalog (e.g. in **apiKey** mode).
- Responses include headers **`X-OmbRouter-Models-Source: openclaw_router_registry`**, **`X-OmbRouter-Paid-BlockRun-Aux-Routes`** (`true` when the BlockRun x402 path is used for aux routes: **x402** / **moonpay**), and **`X-OmbRouter-Aux-Http-Routes-Enabled`** (`true` when aux routes are accepted, including **apiKey** + Bearer forward).
- **`GET /health`** includes **`modelsEndpoint`** with the fields above.

**moonpay vs x402:** Both can target the same BlockRun-compatible HTTPS API; the difference is **where the wallet lives** (MoonPay CLI vs OmbRouter `BLOCKRUN_WALLET_KEY`). You can run **`x402` and `moonpay` in parallel on different ports** or migrate by switching `upstreamMode`; BlockRun is not removed from the codebase as a configurable upstream base for `moonpay`.

### BLOCKRUN_WALLET_KEY

The wallet private key for signing x402 micropayments when using **`x402`** mode (not used for **`apiKey`** or **`moonpay`**).

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

**Resolution order:**

1. Saved file (`~/.openclaw/blockrun/wallet.key`) — checked first
2. `BLOCKRUN_WALLET_KEY` environment variable — used if no saved file
3. Auto-generate — creates new wallet and saves to file

> **Security Note:** The saved file takes priority to prevent accidentally switching wallets and losing access to funded balances.

### BLOCKRUN_PROXY_PORT

Configure the proxy to listen on a different port:

```bash
export BLOCKRUN_PROXY_PORT=8403
openclaw gateway restart
```

**Behavior:**

- If a proxy is already running on the configured port, OmbRouter will **reuse it** instead of failing with `EADDRINUSE`
- The proxy returns the wallet address of the existing instance, not the configured wallet
- A warning is logged if the existing proxy uses a different wallet

**Valid values:** 1-65535 (integers only). Invalid values fall back to 8402.

### OMBROUTER_SOLANA_RPC_URL

Override the Solana RPC endpoint used for USDC balance checks (Solana chain only):

```bash
export OMBROUTER_SOLANA_RPC_URL=https://your-rpc-provider.com
openclaw gateway restart
```

Public RPC may rate-limit on heavy usage. Use a dedicated RPC for production.

---

## Wallet Configuration

OmbRouter supports **two payment chains**: Base (EVM) and Solana. Both are USDC only — no SOL or ETH accepted for payments.

### Check Active Wallet

```bash
# View wallet address + balance (both chains shown)
/wallet

# Or via HTTP
curl http://localhost:8402/health | jq .wallet
curl "http://localhost:8402/health?full=true" | jq
```

Response (dual-chain):

```json
{
  "status": "ok",
  "wallet": "0x1234...abcd",
  "solanaWallet": "7Xkr...xyz",
  "paymentChain": "base",
  "balance": "$2.50",
  "isLow": false,
  "isEmpty": false
}
```

### Switch Payment Chain

```bash
/wallet solana    # Switch to Solana USDC payments
/wallet base      # Switch back to Base (EVM) USDC payments
```

Or use the `/chain` command:

```bash
/chain solana
/chain base
```

The selected chain is persisted across gateway restarts.

### Switch Wallets

To use a different wallet:

```bash
# 1. Remove saved wallet
rm ~/.openclaw/blockrun/wallet.key

# 2. Set new wallet key
export BLOCKRUN_WALLET_KEY=0x...

# 3. Restart
openclaw gateway restart
```

### Backup Wallet

```bash
# Backup wallet key
cp ~/.openclaw/blockrun/wallet.key ~/backup/

# View wallet address from key file
cat ~/.openclaw/blockrun/wallet.key
```

### Wallet Backup & Recovery

OmbRouter generates a **BIP-39 mnemonic** on first install — stored at `~/.openclaw/blockrun/wallet.key`. This single mnemonic derives both your EVM (Base) and Solana addresses. **Back up this file before terminating any VPS or machine!**

#### Using the `/wallet` Command

```bash
# Check wallet status (address, balance, chain, file location)
/wallet

# Export mnemonic + private keys for backup
/wallet export
```

The `/wallet export` command displays your mnemonic and keys so you can copy them before terminating a machine.

#### Manual Backup

```bash
# Option 1: Copy the key file
cp ~/.openclaw/blockrun/wallet.key ~/backup-wallet.key

# Option 2: View mnemonic
cat ~/.openclaw/blockrun/wallet.key
```

#### Restore on a New Machine

```bash
# Option 1: Recover from mnemonic
npx ombrouter wallet recover "word1 word2 ... word12"

# Option 2: Set environment variable (before installing OmbRouter)
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
openclaw plugins install ombrouter

# Option 3: Create the key file directly
mkdir -p ~/.openclaw/blockrun
echo "your twelve word mnemonic here" > ~/.openclaw/blockrun/wallet.key
chmod 600 ~/.openclaw/blockrun/wallet.key
openclaw plugins install ombrouter
```

**Important:** If a saved wallet file exists, it takes priority over the environment variable. To use a different wallet, delete the existing file first.

#### Lost Key Recovery

If you lose your wallet key, **there is no way to recover it**. The wallet is self-custodial, meaning only you have the private key. We do not store keys or have any way to restore access.

**Prevention tips:**

- Run `/wallet export` before terminating any VPS
- Keep a secure backup of `~/.openclaw/blockrun/wallet.key`
- For production use, consider using a hardware wallet or key management system

---

## Proxy Settings

### Proxy Reuse (v0.4.1+)

OmbRouter automatically detects and reuses an existing proxy on startup:

```
Session 1: startProxy() → starts server on :8402
Session 2: startProxy() → detects existing, reuses handle
```

**Behavior:**

- Health check is performed on the configured port before starting
- If responsive, returns a handle that uses the existing proxy
- `close()` on reused handles is a no-op (doesn't stop the original server)
- Warning logged if existing proxy uses a different wallet

### Programmatic Usage

Use OmbRouter without OpenClaw:

```typescript
import { startProxy } from "ombrouter";

const proxy = await startProxy({
  walletKey: process.env.BLOCKRUN_WALLET_KEY!,
  onReady: (port) => console.log(`Proxy on port ${port}`),
  onRouted: (d) => console.log(`${d.model} saved ${(d.savings * 100).toFixed(0)}%`),
});

// Any OpenAI-compatible client works
const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "blockrun/auto",
    messages: [{ role: "user", content: "What is 2+2?" }],
  }),
});

await proxy.close();
```

Or use the router directly (no proxy, no payments):

```typescript
import { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } from "ombrouter";

// Build pricing map
const modelPricing = new Map();
for (const m of BLOCKRUN_MODELS) {
  modelPricing.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
}

const decision = route("Prove sqrt(2) is irrational", undefined, 4096, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
});

console.log(decision);
// {
//   model: "deepseek/deepseek-reasoner",
//   tier: "REASONING",
//   confidence: 0.97,
//   method: "rules",
//   savings: 0.994,
//   costEstimate: 0.002,
// }
```

### Programmatic Options

All options for `startProxy()`:

```typescript
import { startProxy } from "ombrouter";

// x402 (default): pass wallet. moonpay: upstreamMode + moonpayWallet, no local private key.
const proxy = await startProxy({
  walletKey: "0x...",

  // Port configuration
  port: 8402, // Default: 8402 or BLOCKRUN_PROXY_PORT

  // Timeouts
  requestTimeoutMs: 180000, // 3 minutes (covers on-chain tx + LLM response)

  // API base (for testing)
  apiBase: "https://blockrun.ai/api",

  // Callbacks
  onReady: (port) => console.log(`Proxy ready on ${port}`),
  onError: (error) => console.error(error),
  onRouted: (decision) => console.log(decision.model, decision.tier),
  onLowBalance: (info) => console.warn(`Low balance: ${info.balanceUSD}`),
  onInsufficientFunds: (info) => console.error(`Need ${info.requiredUSD}`),
  onPayment: (info) => console.log(`Paid ${info.amount} for ${info.model}`),

  // Routing config overrides
  routingConfig: {
    // See Routing Configuration below
  },
});
```

---

## Routing Configuration

### Via openclaw.yaml

```yaml
plugins:
  - id: "ombrouter"
    config:
      # Maximum spend per session/run in USD.
      # Default: disabled (no limit)
      maxCostPerRun: 0.50 # $0.50 per session

      # How to enforce the budget cap. Default: graceful
      #
      # graceful (default): when budget runs low, OmbRouter automatically downgrades
      #   to cheaper models (premium → auto → eco → free). Tasks keep running.
      #   Only returns an error if no model can serve the request at all.
      #
      # strict: immediately returns 429 (X-OmbRouter-Cost-Cap-Exceeded: 1) once
      #   the session spend reaches the cap. Use when you need a hard budget ceiling.
      maxCostPerRunMode: graceful # or: strict

      # Note: image generation endpoints (/v1/images/generations) bypass maxCostPerRun.
      # Their cost is charged via x402 micropayment directly and is not tracked per-session.

      routing:
        # Override tier assignments
        tiers:
          SIMPLE:
            primary: "google/gemini-2.5-flash"
            fallback: ["deepseek/deepseek-chat"]
          MEDIUM:
            primary: "deepseek/deepseek-chat"
            fallback: ["openai/gpt-4o-mini"]
          COMPLEX:
            primary: "anthropic/claude-sonnet-4.6"
            fallback: ["openai/gpt-4o"]
          REASONING:
            primary: "deepseek/deepseek-reasoner"
            fallback: ["openai/o3-mini"]

        # Override scoring parameters
        scoring:
          reasoningKeywords: ["prove", "theorem", "formal", "derive"]
          codeKeywords: ["function", "class", "async", "import"]
          simpleKeywords: ["what is", "define", "hello"]

        # Override thresholds
        classifier:
          confidenceThreshold: 0.7
          reasoningConfidence: 0.97

        # Context-based overrides
        overrides:
          largeContextTokens: 100000 # Force COMPLEX above this
          structuredOutput: true # Bump to min MEDIUM for JSON/YAML
```

---

## Tier Overrides

### Default Tier Mappings

| Tier      | Primary Model                 | Fallback Chain                                  |
| --------- | ----------------------------- | ----------------------------------------------- |
| SIMPLE    | `google/gemini-2.5-flash`     | `deepseek/deepseek-chat`                        |
| MEDIUM    | `deepseek/deepseek-chat`      | `openai/gpt-4o-mini`, `google/gemini-2.5-flash` |
| COMPLEX   | `anthropic/claude-sonnet-4.6` | `openai/gpt-4o`, `google/gemini-2.5-pro`        |
| REASONING | `deepseek/deepseek-reasoner`  | `openai/o3-mini`, `anthropic/claude-sonnet-4.6` |

### Fallback Chain

When the primary model fails (rate limits, billing errors, provider outages), OmbRouter tries the next model in the fallback chain:

```
Request → gemini-2.5-flash (rate limited)
       → deepseek-chat (billing error)
       → gpt-4o-mini (success)
```

Max fallback attempts: 3 models per request.

### Custom Tier Configuration

```yaml
routing:
  tiers:
    COMPLEX:
      primary: "openai/gpt-4o" # Use GPT-4o instead of Claude
      fallback:
        - "anthropic/claude-sonnet-4.6"
        - "google/gemini-2.5-pro"
```

---

## Scoring Weights

The 15-dimension weighted scorer determines query complexity:

| Dimension             | Weight | Detection                                |
| --------------------- | ------ | ---------------------------------------- |
| `reasoningMarkers`    | 0.18   | "prove", "theorem", "step by step"       |
| `codePresence`        | 0.15   | "function", "async", "import", "```"     |
| `multiStepPatterns`   | 0.12   | "first...then", "step 1", numbered lists |
| `agenticTask`         | 0.10   | "run", "test", "fix", "deploy", "edit"   |
| `technicalTerms`      | 0.10   | "algorithm", "kubernetes", "distributed" |
| `tokenCount`          | 0.08   | short (<50) vs long (>500)               |
| `creativeMarkers`     | 0.05   | "story", "poem", "brainstorm"            |
| `questionComplexity`  | 0.05   | Multiple question marks                  |
| `constraintCount`     | 0.04   | "at most", "O(n)", "maximum"             |
| `imperativeVerbs`     | 0.03   | "build", "create", "implement"           |
| `outputFormat`        | 0.03   | "json", "yaml", "schema"                 |
| `simpleIndicators`    | 0.02   | "what is", "define", "translate"         |
| `domainSpecificity`   | 0.02   | "quantum", "fpga", "genomics"            |
| `referenceComplexity` | 0.02   | "the docs", "the api", "above"           |
| `negationComplexity`  | 0.01   | "don't", "avoid", "without"              |

### Custom Keywords

```yaml
routing:
  scoring:
    # Add domain-specific reasoning triggers
    reasoningKeywords:
      - "prove"
      - "theorem"
      - "formal verification"
      - "type theory" # Custom

    # Add framework-specific code triggers
    codeKeywords:
      - "function"
      - "useEffect" # React-specific
      - "prisma" # ORM-specific
```

---

## Advanced: Confidence Calibration

The classifier uses sigmoid calibration to convert raw scores to confidence values:

```
confidence = 1 / (1 + exp(-k * (score - midpoint)))
```

Parameters:

- `k = 8` — steepness of the sigmoid curve
- `midpoint = 0.5` — score at which confidence = 50%

### Override Thresholds

```yaml
routing:
  classifier:
    # Require higher confidence for tier assignment
    confidenceThreshold: 0.8 # Default: 0.7

    # Force REASONING tier at lower confidence
    reasoningConfidence: 0.90 # Default: 0.97
```

---

## Testing Configuration

### Dry Run (No Payments)

For testing routing without spending USDC:

```typescript
import { route, DEFAULT_ROUTING_CONFIG, BLOCKRUN_MODELS } from "ombrouter";

// Build pricing map
const modelPricing = new Map();
for (const m of BLOCKRUN_MODELS) {
  modelPricing.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
}

// Test routing decisions locally
const decision = route("Prove sqrt(2) is irrational", undefined, 4096, {
  config: DEFAULT_ROUTING_CONFIG,
  modelPricing,
});

console.log(decision);
// { model: "deepseek/deepseek-reasoner", tier: "REASONING", ... }
```

### Run Tests

```bash
# Router tests (no wallet needed)
npx tsx test/e2e.ts

# Proxy reuse tests
npx tsx test/proxy-reuse.ts

# Full e2e with payments (requires funded wallet)
BLOCKRUN_WALLET_KEY=0x... npx tsx test/e2e.ts
```
