# systemd user units (dual proxy)

Linux example units for running **two** OmbRouter processes: **x402** on port **8402** and **apiKey** on **8403**.

## Prerequisites

- `ombrouter` on `PATH`, or set `ExecStart` to the full path (e.g. output of `which ombrouter`).
- Copy unit files and edit paths if needed:

```bash
mkdir -p ~/.config/systemd/user
cp ombrouter-x402.service.example ~/.config/systemd/user/ombrouter-x402.service
cp ombrouter-apikey.service.example ~/.config/systemd/user/ombrouter-apikey.service
```

- For **apiKey**, create a root-owned or user-readable env file with secrets (mode `600`), e.g. `~/.config/ombrouter/apikey.env`:

```bash
OMBROUTER_UPSTREAM_API_BASE=https://api.openai.com/v1
OMBROUTER_UPSTREAM_API_KEY=sk-...
```

Adjust the `EnvironmentFile=` line in `ombrouter-apikey.service` if you use a different path.

## Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable --now ombrouter-x402.service
systemctl --user enable --now ombrouter-apikey.service
systemctl --user status ombrouter-x402.service ombrouter-apikey.service
```

Enable lingering if units must start without an interactive login:

```bash
loginctl enable-linger "$USER"
```

See also [docs/dual-proxy-deployment.md](../../docs/dual-proxy-deployment.md).
