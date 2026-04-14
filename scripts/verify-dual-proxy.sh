#!/usr/bin/env bash
# Verify two OmbRouter instances: auxiliary (x402/moonpay) and chat (apiKey).
# Usage:
#   ./scripts/verify-dual-proxy.sh
#   DUAL_PROXY_AUX_PORT=8402 DUAL_PROXY_CHAT_PORT=8403 ./scripts/verify-dual-proxy.sh
set -euo pipefail

AUX_PORT="${DUAL_PROXY_AUX_PORT:-8402}"
CHAT_PORT="${DUAL_PROXY_CHAT_PORT:-8403}"

die() {
  echo "verify-dual-proxy: $*" >&2
  exit 1
}

check_health() {
  local port="$1"
  local label="$2"
  local url="http://127.0.0.1:${port}/health"
  local body
  if ! body="$(curl -sfS "$url")"; then
    die "no response from ${label} on port ${port} (${url})"
  fi
  echo "$body"
}

echo "Checking auxiliary (x402/moonpay) on :${AUX_PORT}..."
aux_json="$(check_health "$AUX_PORT" "auxiliary")"
aux_mode="$(echo "$aux_json" | node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(j.upstreamMode||''));")"
case "$aux_mode" in
  x402|moonpay) echo "  upstreamMode=$aux_mode OK" ;;
  *) die "auxiliary port ${AUX_PORT}: expected upstreamMode x402 or moonpay, got '${aux_mode}'" ;;
esac

echo "Checking chat (apiKey) on :${CHAT_PORT}..."
chat_json="$(check_health "$CHAT_PORT" "chat")"
chat_mode="$(echo "$chat_json" | node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(String(j.upstreamMode||''));")"
if [[ "$chat_mode" != "apiKey" ]]; then
  die "chat port ${CHAT_PORT}: expected upstreamMode apiKey, got '${chat_mode}'"
fi
echo "  upstreamMode=apiKey OK"

if [[ "$AUX_PORT" == "$CHAT_PORT" ]]; then
  die "DUAL_PROXY_AUX_PORT and DUAL_PROXY_CHAT_PORT must differ"
fi

echo "Dual-proxy health check passed."
