# OpenClaw integration and responsibility boundary

OmbRouter is an OpenClaw plugin (`id: ombrouter` in the manifest) that starts a **local OpenAI-compatible HTTP proxy** on `127.0.0.1` and forwards requests to your configured **upstream** OpenAI-compatible API.

## Who owns what

| Concern | Owner | Notes |
| ------- | ----- | ----- |
| Local `/v1/*` surface, smart routing, tier selection | **OmbRouter** | Listens on `http://127.0.0.1:<port>/v1` by default. |
| Upstream URL and Bearer token for the real LLM API | **OmbRouter plugin config** (`baseUrl`, `apiKey`) or `OMBROUTER_BASE_URL` / `OMBROUTER_API_KEY` | The proxy adds `Authorization: Bearer` when a key is set. |
| OpenClaw model registry entry for `ombrouter` | **OmbRouter** (`injectModelsConfig`) | Writes `models.providers.ombrouter` with `baseUrl` pointing at the local proxy, `api: openai-completions`, and a placeholder `apiKey` for the picker. Optional plugin field **`openclawProviderExtras`** merges only **missing** top-level keys (and `request` only if absent). |
| TLS/mTLS from OpenClaw’s HTTP client **to** the local proxy | **OpenClaw** | Configure under `models.providers.ombrouter.request.tls` (and related `request.*` fields) in `openclaw.json` if you terminate TLS in front of the proxy (uncommon; default is plain HTTP on loopback). |
| TLS from the **proxy** to the upstream API | **Node/`fetch`** | Use an `https://` upstream `baseUrl`; optional corporate HTTP proxy via `upstreamProxy` / env. |

## Default: HTTP on loopback

The supported default is **`http://127.0.0.1:<port>/v1`** for OpenClaw → OmbRouter. You do **not** need mTLS for that hop in a typical single-user desktop setup.

## Optional mTLS (OpenClaw → local proxy)

If your organization requires **mutual TLS** on the hop from OpenClaw to the proxy, you typically:

1. Put a **local TLS terminator** (reverse proxy or sidecar) in front of OmbRouter, or serve the proxy over HTTPS with client certificates.
2. Set **`models.providers.ombrouter.request.tls`** in `openclaw.json` with OpenClaw-supported fields (for example `cert`, `key`, `ca`, `serverName`, `passphrase`), as documented in OpenClaw’s provider HTTP configuration and SecretRef credential surface (`models.providers.*.request.tls.*`).

OmbRouter’s injector **only** updates `baseUrl`, `api`, `apiKey`, and `models` on `providers.ombrouter`. It does **not** remove a sibling **`request`** object; you can add `request.tls` manually and it will be preserved across gateway restarts when injection runs. Alternatively, set **`openclawProviderExtras.request`** in plugin config to seed TLS once (ignored if `request` already exists in `openclaw.json`).

## OpenClaw version compatibility (matrix)

Declared in **`package.json`** under `openclaw.compat`:

| Field | Declared value | Meaning |
| ----- | -------------- | ------- |
| `pluginApiRange` | `>=2026.3.24` | Minimum OpenClaw plugin API version OmbRouter targets. |
| `minGatewayVersion` | `2026.4.5` | Minimum gateway version expected for full behavior. |

**CI / dev:** `devDependencies.openclaw` pins the OpenClaw package version used for typecheck and tests (including the security scanner integration test). Upgrade that pin when validating a new OpenClaw release; keep `openclaw.compat` accurate for published installs.

## Usage logging (SIEM)

OmbRouter appends JSON lines under:

`~/.openclaw/ombrouter/logs/usage-YYYY-MM-DD.jsonl`

Entries include model, tier, cost estimates, latency, and status — **not** full prompt text. Forward these files with your log agent if you need SIEM visibility.

## Commands registered with OpenClaw

- `/ombrouter` — upstream (from env) and local proxy URL
- `/stats`, `/exclude` — usage and exclude-model management

See [configuration.md](./configuration.md) for plugin YAML, env vars, and routing.
