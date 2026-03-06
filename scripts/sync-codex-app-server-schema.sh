#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
SCHEMA_ROOT="$REPO_ROOT/schema/codex-app-server-protocol"
TS_OUT="$SCHEMA_ROOT/typescript"
JSON_OUT="$SCHEMA_ROOT/json"
META_OUT="$SCHEMA_ROOT/generator.json"
CODEX_BIN=${CODEX_BIN:-codex}
EXPERIMENTAL=${CODEX_APP_SERVER_EXPERIMENTAL:-0}

json_escape() {
  local value=${1-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/}
  printf '"%s"' "$value"
}

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "codex binary not found: $CODEX_BIN" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$SCHEMA_ROOT"

TS_TMP="$TMP_DIR/typescript"
JSON_TMP="$TMP_DIR/json"
mkdir -p "$TS_TMP" "$JSON_TMP"

version=$($CODEX_BIN --version | head -n 1 | tr -d '\r')

ts_cmd=("$CODEX_BIN" app-server generate-ts --out "$TS_TMP")
json_cmd=("$CODEX_BIN" app-server generate-json-schema --out "$JSON_TMP")
recorded_ts_cmd=("$CODEX_BIN" app-server generate-ts --out "schema/codex-app-server-protocol/typescript")
recorded_json_cmd=("$CODEX_BIN" app-server generate-json-schema --out "schema/codex-app-server-protocol/json")
if [[ "$EXPERIMENTAL" == "1" ]]; then
  ts_cmd+=(--experimental)
  json_cmd+=(--experimental)
  recorded_ts_cmd+=(--experimental)
  recorded_json_cmd+=(--experimental)
fi

"${ts_cmd[@]}"
"${json_cmd[@]}"

rm -rf "$TS_OUT" "$JSON_OUT"
mv "$TS_TMP" "$TS_OUT"
mv "$JSON_TMP" "$JSON_OUT"

cat > "$META_OUT" <<META
{
  "generator": "codex app-server",
  "codex_cli_version": $(json_escape "$version"),
  "experimental": $([[ "$EXPERIMENTAL" == "1" ]] && echo true || echo false),
  "typescript_dir": "schema/codex-app-server-protocol/typescript",
  "json_dir": "schema/codex-app-server-protocol/json",
  "commands": [
    $(json_escape "${recorded_ts_cmd[*]}"),
    $(json_escape "${recorded_json_cmd[*]}")
  ]
}
META

echo "Synced Codex app-server schema to $SCHEMA_ROOT"
