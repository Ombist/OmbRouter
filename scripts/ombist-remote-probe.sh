#!/usr/bin/env bash
# Ombist remote probe: same contract as `ombot-admin router probe --json` (one JSON line).
# Reads OpenClaw config via direct read or `sudo -n cat` when unprivileged.
# shellcheck shell=bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${ROOT}/lib/ombist-json-envelope.sh"

cfg="${OPENCLAW_CONFIG_PATH:-/etc/ombot/openclaw.json}"
proxy_b64="${OMBIST_PROBE_PROXY_B64:-}"
min_b64="${OMBIST_MIN_VERSION_B64:-}"

node_bin="$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)"
if [[ -z "${node_bin}" ]]; then
  err="$(printf '[{"code":"NO_NODE","message":%s}]' "$(ombist_json_escape_string "node not in PATH")")"
  ombist_emit_envelope false "router_probe" "node not found." "{}" "[]" "${err}"
  exit 0
fi

cfg_body=""
if [[ -r "${cfg}" ]]; then
  cfg_body="$(cat "${cfg}" 2>/dev/null || true)"
elif command -v sudo >/dev/null 2>&1 && sudo -n test -r "${cfg}" 2>/dev/null; then
  cfg_body="$(sudo -n cat "${cfg}" 2>/dev/null || true)"
fi

export OMBIST_CFG_BODY="${cfg_body}"
export OMBIST_PROBE_PROXY_B64="${proxy_b64}"
export OMBIST_MIN_VERSION_B64="${min_b64}"

set +e
out="$(
  "${node_bin}" - <<'NODE'
const { execSync } = require('child_process');

function b64d(v) {
  if (!v) return '';
  try {
    return Buffer.from(String(v).trim(), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}
const proxy = b64d(process.env.OMBIST_PROBE_PROXY_B64).trim();
let minV = b64d(process.env.OMBIST_MIN_VERSION_B64).trim();
if (!minV) minV = '1.0.0';

function parts(v) {
  const h = String(v || '').split(/[-+]/)[0];
  return h.split('.').map((s) => {
    const m = String(s).match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
}
function lt(a, b) {
  const A = parts(a);
  const B = parts(b);
  const n = Math.max(A.length, B.length, 1);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0;
    const y = B[i] || 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

let plugin = false;
try {
  const raw = (process.env.OMBIST_CFG_BODY || '').trim();
  if (raw) {
    const j = JSON.parse(raw);
    plugin = Array.isArray(j.plugins) && j.plugins.some((p) => p && p.id === 'ombrouter');
  }
} catch (_) {}

let curlOk = false;
if (/^https?:\/\/.+/i.test(proxy)) {
  const base = proxy.replace(/\/+$/, '');
  try {
    execSync('curl -sf --max-time 3 ' + JSON.stringify(base + '/models'), { stdio: 'ignore' });
    curlOk = true;
  } catch (_) {}
}

let ver = '';
try {
  const s = execSync('npm list -g ombrouter --depth=0 2>/dev/null', { encoding: 'utf8' });
  const m = s.match(/ombrouter@([0-9][^\s)]*)/);
  if (m) ver = m[1].trim();
} catch (_) {}
if (!ver) {
  try {
    execSync('command -v ombrouter >/dev/null 2>&1', { stdio: 'ignore' });
    const t = execSync('ombrouter --version 2>/dev/null', { encoding: 'utf8' });
    ver = String(t || '').trim().split(/\r?\n/)[0] || '';
  } catch (_) {}
}

if (plugin || curlOk) {
  if (ver && lt(ver, minV)) {
    process.stdout.write(
      JSON.stringify({
        status: 'presentOutdated',
        version: ver,
        detail: '已安裝 ' + ver + '，App 建議至少 ' + minV + '。',
      })
    );
  } else {
    process.stdout.write(JSON.stringify({ status: 'presentOk', version: ver || null, detail: '' }));
  }
} else {
  process.stdout.write(
    JSON.stringify({
      status: 'missing',
      version: null,
      detail: '未偵測到 OpenClaw router 外掛且 proxy 無法取得 /v1/models。',
    })
  );
}
NODE
)"
rc=$?
set -e

if [[ "${rc}" -ne 0 ]] || [[ -z "${out}" ]] || [[ "${out}" != \{* ]]; then
  err="$(printf '[{"code":"PROBE_FAILED","message":%s}]' "$(ombist_json_escape_string "probe script failed")")"
  ombist_emit_envelope false "router_probe" "probe failed." "{}" "[]" "${err}"
  exit 0
fi

status="$("${node_bin}" -p "JSON.parse(process.argv[1]).status||''" "${out}" 2>/dev/null || true)"
version="$("${node_bin}" -p "const v=JSON.parse(process.argv[1]).version; v===null?'':String(v||'')" "${out}" 2>/dev/null || true)"
detail="$("${node_bin}" -p "const v=JSON.parse(process.argv[1]).detail; v===null?'':String(v||'')" "${out}" 2>/dev/null || true)"

if [[ -z "${status}" ]]; then
  err="$(printf '[{"code":"PROBE_FAILED","message":%s}]' "$(ombist_json_escape_string "probe output missing status")")"
  ombist_emit_envelope false "router_probe" "probe failed." "{}" "[]" "${err}"
  exit 0
fi

data="$(printf '{"status":%s,"version":%s,"detail":%s}' \
  "$(ombist_json_escape_string "${status}")" \
  "$(ombist_json_escape_string "${version}")" \
  "$(ombist_json_escape_string "${detail}")")"
summary="router probe: ${status}"
ombist_emit_envelope true "router_probe" "${summary}" "${data}" "[]" "[]"
