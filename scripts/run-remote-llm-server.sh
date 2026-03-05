#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server_bin="${script_dir}/remote-llm-server"

if [ ! -x "${server_bin}" ]; then
  echo "remote-llm-server binary not found or not executable: ${server_bin}" >&2
  exit 1
fi

addr="${REMOTE_LLM_ADDR:-:8080}"
data_path="${REMOTE_LLM_DATA_PATH:-./data/state.json}"
runtime_config="${REMOTE_LLM_RUNTIME_CONFIG:-}"
cors_allow_origins="${REMOTE_LLM_CORS_ALLOW_ORIGINS:-}"
extra_args="${REMOTE_LLM_EXTRA_ARGS:-}"

args=(--addr "${addr}" --data "${data_path}")
if [ -n "${runtime_config}" ]; then
  args+=(--runtime-config "${runtime_config}")
fi
if [ -n "${cors_allow_origins}" ]; then
  args+=(--cors-allow-origins "${cors_allow_origins}")
fi

if [ -n "${extra_args}" ]; then
  # shellcheck disable=SC2206
  parsed_extra_args=(${extra_args})
  args+=("${parsed_extra_args[@]}")
fi

exec "${server_bin}" "${args[@]}"
