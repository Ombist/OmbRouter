# Dual proxy deployment (apiKey + x402)

Run **two** OmbRouter processes on **different ports**: one for **Bearer / bring-your-own-key** chat (`apiKey`), and one for **x402** (or **moonpay**) when you want **BlockRun micropayments** for image generation, audio, and partner APIs (`/v1/x/*`, `/v1/pm/*`, etc.).

**When a single `apiKey` instance is enough:** If your **`upstreamApiBase`** already implements the paths you need (e.g. OpenAI **`/v1/images/*`** on the same base), you can enable **optional Bearer forwarding** for auxiliary routes (`upstreamApiKeyAllowAuxRoutes` / `OMBROUTER_APIKEY_AUX_ROUTES`) and **skip** a second x402 proxy — see [configuration.md](./configuration.md#upstream-transport-x402-apikey-moonpay). Use **dual proxy** when you still want **chat** on BYOK while **paid** image/partner traffic goes through **BlockRun x402** on another port.

If auxiliary Bearer forwarding is **off** (default), **`apiKey`** alone still returns **501** for those routes unless you use **x402** / **moonpay** or enable the option above.

**Hard rule:** Do **not** bind two different `upstreamMode` values to the **same** port. OmbRouter rejects reuse when the existing proxy’s mode does not match.

## Suggested layout

| Instance | Example port | `upstreamMode` | Role |
| -------- | ------------ | ---------------- | ---- |
| A | `8402` (default) | `x402` or `moonpay` | Images, audio, partner APIs; optional chat via BlockRun |
| B | `8403` | `apiKey` | OpenClaw **primary chat** when using your own upstream API key |

Ports are conventions — any two distinct ports work.

## 1. Environment variables per process

**x402 instance (auxiliary / paid routes)**

- `BLOCKRUN_PROXY_PORT=8402` (or omit; default is `8402`)
- Do **not** set `OMBROUTER_UPSTREAM_MODE=apiKey`
- Fund wallet per [configuration.md](./configuration.md#wallet-configuration)

**apiKey instance (chat)**

- `BLOCKRUN_PROXY_PORT=8403`
- `OMBROUTER_UPSTREAM_MODE=apiKey`
- `OMBROUTER_UPSTREAM_API_BASE` — OpenAI-compatible base URL (e.g. `https://api.openai.com/v1`)
- `OMBROUTER_UPSTREAM_API_KEY` — secret; never commit

Copy [scripts/dual-proxy-example.env](../scripts/dual-proxy-example.env) as a template (comments only).

Startup order does not matter as long as ports do not collide.

## 2. OpenClaw: point chat at the apiKey instance

1. In the OmbRouter plugin config, set `upstreamMode` to `"apiKey"` and fill `upstreamApiBase` / `upstreamApiKey`.
2. Set **`BLOCKRUN_PROXY_PORT`** to the **apiKey** port (e.g. `8403`) in the **gateway** process environment so the plugin’s proxy and config injection use the same listen port.
3. Restart the gateway. The plugin injects `models.providers.blockrun.baseUrl` as `http://127.0.0.1:<port>/v1` where `<port>` comes from `BLOCKRUN_PROXY_PORT` at process load (see [src/config.ts](../src/config.ts)).

Verify in `~/.openclaw/openclaw.json` that `models.providers.blockrun.baseUrl` matches your apiKey port, e.g. `http://127.0.0.1:8403/v1`.

## 3. Standalone second process for x402

Start a **second** `ombrouter` (separate terminal, **systemd** unit, or **pm2**) with **`BLOCKRUN_PROXY_PORT=8402`** (or any port **different** from the apiKey instance). Example:

```bash
BLOCKRUN_PROXY_PORT=8402 ombrouter
```

Use `moonpay` instead of `x402` if the wallet should live in MoonPay CLI; constraints are in [configuration.md](./configuration.md#upstream-transport-x402-apikey-moonpay).

## 4. Skills and scripts

Bundled skills (imagegen, predexon, x-api, etc.) use **`http://localhost:8402`** in examples — the default **x402** port. If your auxiliary instance uses **8402**, no change is needed. If it uses another port, replace the host/port in tool calls or internal scripts to match the **x402** instance, **not** the apiKey instance.

## 5. Verification

Health:

```bash
curl -sS "http://127.0.0.1:8402/health" | jq .upstreamMode   # expect x402 or moonpay
curl -sS "http://127.0.0.1:8403/health" | jq .upstreamMode   # expect apiKey
```

Or run [scripts/verify-dual-proxy.sh](../scripts/verify-dual-proxy.sh) (adjust ports via env vars documented in the script).

**apiKey port:** `POST /v1/chat/completions` should succeed against your upstream; `POST /v1/images/generations` should return **501** (expected).

**x402 port:** image/partner routes should participate in x402 (wallet funded, upstream reachable).

## 6. Operations

- Two long-running processes → two health endpoints and log streams; keep versions aligned on upgrade.
- Optional team convention: document “8402 = paid aux, 8403 = BYOK chat” so skills and dashboards stay consistent.

For a single HTTP entry that splits traffic by path, you need an external reverse proxy or custom router — OmbRouter does not merge two modes on one port.

## 7. Long-running: systemd (Linux, optional)

User-level units for **x402** and **apiKey** on **8402** / **8403** are provided as examples:

- [scripts/systemd/README.md](../scripts/systemd/README.md) — install, `EnvironmentFile` for apiKey secrets, `loginctl enable-linger`
- [scripts/systemd/ombrouter-x402.service.example](../scripts/systemd/ombrouter-x402.service.example)
- [scripts/systemd/ombrouter-apikey.service.example](../scripts/systemd/ombrouter-apikey.service.example)

## 8. OpenClaw gateway environment

The gateway process must see **`BLOCKRUN_PROXY_PORT`** equal to your **apiKey** listen port (e.g. `8403`) so plugin injection matches. Examples:

- **Shell:** `export BLOCKRUN_PROXY_PORT=8403` before `openclaw gateway` (or in the same environment as your gateway service).
- **systemd** (gateway): add `Environment=BLOCKRUN_PROXY_PORT=8403` to the **OpenClaw gateway** unit, not only to the OmbRouter apiKey proxy.

Keep [scripts/dual-proxy-example.env](../scripts/dual-proxy-example.env) as a reference; do not commit real keys.
