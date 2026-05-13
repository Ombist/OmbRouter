# Ombist remote maintenance (SSH)

Ombist iOS can manage OmbRouter on a Linux host **without** going through `ombot-admin` by running scripts from this repository. Output matches the `ombot-admin … --json` envelope (one JSON object per invocation on stdout):

`{"ok":true|false,"mode":"…","summary":"…","data":{…},"warnings":[],"errors":[]}`

## Scripts

| Script | `mode` (on success) | Purpose |
|--------|---------------------|---------|
| `scripts/ombist-remote-probe.sh` | `router_probe` | Detect OmbRouter plugin / proxy `/models` reachability and semver vs minimum. |
| `scripts/ombist-remote-install.sh` | `router_install` | Clone or update source, `npm install`, `npm run build`, `npm install -g .`, optional gateway restart. Does **not** run `openclaw plugins install`. |

Both require `bash`. Install additionally requires `git` and `npm`. Probe requires `node` (or `nodejs`) on `PATH`.

## Environment variables

### Probe (`ombist-remote-probe.sh`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_CONFIG_PATH` | `/etc/ombot/openclaw.json` | Path to OpenClaw JSON. If not readable as the SSH user, the script tries `sudo -n cat` when `sudo -n test -r` succeeds. |
| `OMBIST_PROBE_PROXY_B64` | (empty) | Base64-encoded HTTP(S) base URL of the OmbRouter proxy (used with `curl` against `…/models`). |
| `OMBIST_MIN_VERSION_B64` | (empty) | Base64-encoded minimum semver string; defaults to `1.0.0` when missing. |

On success, `data` contains `status` (`presentOk` \| `presentOutdated` \| `missing`), `version`, and `detail`.

### Install (`ombist-remote-install.sh`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OMBROUTER_GIT_URL` | `https://github.com/Ombist/OmbRouter.git` | Git remote for clone / fetch. |
| `OMBROUTER_SRC_DIR` | `$HOME/.ombist/src/OmbRouter` | Working tree path. |
| `OMBROUTER_PINNED_REF` | (empty) | Optional full SHA or ref to `git fetch` + `checkout`. |

On success, `summary` contains `ombist_router_install_ok` and `data.router.sourceDir` is set.

## Typical iOS / SSH sequence (OMB path)

1. Ensure `git`, `node`, `npm` are available (preflight).
2. `git clone` or `git -C "$OMBROUTER_SRC_DIR" pull` as needed; optional `git fetch` + checkout of policy-pinned ref.
3. Run `bash "$OMBROUTER_SRC_DIR/scripts/ombist-remote-probe.sh"` or `bash "$OMBROUTER_SRC_DIR/scripts/ombist-remote-install.sh"` so the scripts always match the checked-out tree.

Using the scripts from the repo checkout avoids relying on `/opt/ombot/bin/ombot-admin` for OMB-mode hosts. On hosts that **do** use `ombot-admin`, the equivalent commands are `ombot-admin router probe` and `ombot-admin router install`.
