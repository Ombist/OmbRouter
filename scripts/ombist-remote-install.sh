#!/usr/bin/env bash
# Ombist remote install: same contract as `ombot-admin router install --json` (one JSON line).
# Clone/build OmbRouter and `npm install -g .` without OpenClaw plugin registration.
# Optional: OMBROUTER_GIT_URL, OMBROUTER_PINNED_REF, OMBROUTER_SRC_DIR (default ~/.ombist/src/OmbRouter).
# shellcheck shell=bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "${ROOT}/lib/ombist-json-envelope.sh"

set +e
pinned_ref="${OMBROUTER_PINNED_REF:-}"
GIT_URL="${OMBROUTER_GIT_URL:-https://github.com/Ombist/OmbRouter.git}"
SRC_DIR="${OMBROUTER_SRC_DIR:-${HOME}/.ombist/src/OmbRouter}"
summary="ombist_router_install_ok"
err_json="[]"

if ! command -v git >/dev/null 2>&1; then
  err_json="$(printf '[{"code":"NO_GIT","message":%s}]' "$(ombist_json_escape_string "git not found")")"
  ombist_emit_envelope false "router_install" "git not found." "{}" "[]" "${err_json}"
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  err_json="$(printf '[{"code":"NO_NPM","message":%s}]' "$(ombist_json_escape_string "npm not found")")"
  ombist_emit_envelope false "router_install" "npm not found." "{}" "[]" "${err_json}"
  exit 0
fi

if ! mkdir -p "$(dirname "${SRC_DIR}")"; then
  err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to create source parent directory")")"
  ombist_emit_envelope false "router_install" "failed to prepare source directory." "{}" "[]" "${err_json}"
  exit 0
fi

if [[ -d "${SRC_DIR}/.git" ]]; then
  if ! cd "${SRC_DIR}"; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter source directory")")"
    ombist_emit_envelope false "router_install" "failed to enter source directory." "{}" "[]" "${err_json}"
    exit 0
  fi
  if ! git pull --ff-only 2>/dev/null; then
    if ! cd "${HOME}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to return to home directory")")"
      ombist_emit_envelope false "router_install" "failed to reset source directory." "{}" "[]" "${err_json}"
      exit 0
    fi
    rm -rf "${SRC_DIR}"
    if ! git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "git clone failed after pull fallback")")"
      ombist_emit_envelope false "router_install" "git clone failed." "{}" "[]" "${err_json}"
      exit 0
    fi
    if ! cd "${SRC_DIR}"; then
      err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter cloned source directory")")"
      ombist_emit_envelope false "router_install" "failed to enter source directory." "{}" "[]" "${err_json}"
      exit 0
    fi
  fi
else
  rm -rf "${SRC_DIR}"
  if ! git clone --depth 1 "${GIT_URL}" "${SRC_DIR}"; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "git clone failed")")"
    ombist_emit_envelope false "router_install" "git clone failed." "{}" "[]" "${err_json}"
    exit 0
  fi
  if ! cd "${SRC_DIR}"; then
    err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "failed to enter cloned source directory")")"
    ombist_emit_envelope false "router_install" "failed to enter source directory." "{}" "[]" "${err_json}"
    exit 0
  fi
fi

if [[ -n "${pinned_ref}" ]]; then
  git fetch origin "${pinned_ref}" 2>/dev/null || true
  git checkout --detach "${pinned_ref}" 2>/dev/null || git checkout "${pinned_ref}" 2>/dev/null || true
fi

if ! npm install; then
  err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm install failed")")"
  ombist_emit_envelope false "router_install" "npm install failed." "{}" "[]" "${err_json}"
  exit 0
fi
if ! npm run build; then
  err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm run build failed")")"
  ombist_emit_envelope false "router_install" "npm run build failed." "{}" "[]" "${err_json}"
  exit 0
fi
if ! npm install -g .; then
  err_json="$(printf '[{"code":"INSTALL_FAILED","message":%s}]' "$(ombist_json_escape_string "npm install -g failed")")"
  ombist_emit_envelope false "router_install" "npm install -g failed." "{}" "[]" "${err_json}"
  exit 0
fi

# Intentionally skip `openclaw plugins install` for OmbRouter.
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  if sudo -n systemctl list-unit-files 2>/dev/null | grep -q '^ombist-openclaw-gateway.service'; then
    sudo -n systemctl restart ombist-openclaw-gateway.service || true
  fi
fi

data="$(printf '{"router":{"okMarker":"ombist_router_install_ok","sourceDir":%s}}' "$(ombist_json_escape_string "${SRC_DIR}")")"
ombist_emit_envelope true "router_install" "${summary}" "${data}" "[]" "[]"
