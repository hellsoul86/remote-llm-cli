#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    echo "missing required environment variable: ${key}" >&2
    exit 1
  fi
}

require_env "DEPLOY_HOST"
require_env "DEPLOY_USER"
require_env "DEPLOY_SSH_KEY_PATH"
require_env "DEPLOY_RELEASE_TARBALL"
require_env "DEPLOY_RELEASE_ID"

if [ ! -f "${DEPLOY_RELEASE_TARBALL}" ]; then
  echo "release tarball not found: ${DEPLOY_RELEASE_TARBALL}" >&2
  exit 1
fi

if [ ! -f "${DEPLOY_SSH_KEY_PATH}" ]; then
  echo "ssh key path not found: ${DEPLOY_SSH_KEY_PATH}" >&2
  exit 1
fi

deploy_port="${DEPLOY_PORT:-22}"
deploy_path="${DEPLOY_PATH:-/opt/remote-llm-cli}"
deploy_service_name="${DEPLOY_SERVICE_NAME:-remote-llm-server}"
deploy_keep_releases="${DEPLOY_KEEP_RELEASES:-5}"
deploy_healthcheck_url="${DEPLOY_HEALTHCHECK_URL:-http://127.0.0.1:8080/v1/healthz}"
deploy_data_path="${DEPLOY_DATA_PATH:-${deploy_path}/shared/state.json}"
deploy_runtime_config_path="${DEPLOY_RUNTIME_CONFIG_PATH:-}"
deploy_addr="${DEPLOY_ADDR:-:8080}"

remote="${DEPLOY_USER}@${DEPLOY_HOST}"
remote_tmp_tgz="/tmp/remote-llm-release-${DEPLOY_RELEASE_ID}.tgz"

ssh_opts=(
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -i "${DEPLOY_SSH_KEY_PATH}"
  -p "${deploy_port}"
)

if [ -n "${DEPLOY_SSH_KNOWN_HOSTS_PATH:-}" ]; then
  if [ ! -f "${DEPLOY_SSH_KNOWN_HOSTS_PATH}" ]; then
    echo "known_hosts file not found: ${DEPLOY_SSH_KNOWN_HOSTS_PATH}" >&2
    exit 1
  fi
  ssh_opts+=(
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="${DEPLOY_SSH_KNOWN_HOSTS_PATH}"
  )
else
  ssh_opts+=(-o StrictHostKeyChecking=accept-new)
fi

echo "upload release to ${remote}:${remote_tmp_tgz}"
scp "${ssh_opts[@]}" "${DEPLOY_RELEASE_TARBALL}" "${remote}:${remote_tmp_tgz}"

echo "deploy release ${DEPLOY_RELEASE_ID} on ${remote}"
ssh "${ssh_opts[@]}" "${remote}" "bash -s -- \
  \"${deploy_path}\" \
  \"${deploy_service_name}\" \
  \"${DEPLOY_RELEASE_ID}\" \
  \"${remote_tmp_tgz}\" \
  \"${deploy_data_path}\" \
  \"${deploy_runtime_config_path}\" \
  \"${deploy_addr}\" \
  \"${deploy_keep_releases}\" \
  \"${deploy_healthcheck_url}\"" <<'REMOTE_SCRIPT'
set -euo pipefail

deploy_path="$1"
service_name="$2"
release_id="$3"
tmp_tgz="$4"
data_path="$5"
runtime_config_path="$6"
listen_addr="$7"
keep_releases="$8"
healthcheck_url="$9"

run_user="$(id -un)"
run_group="$(id -gn)"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif sudo -n true >/dev/null 2>&1; then
  SUDO="sudo -n"
else
  echo "passwordless sudo is required on target host for service install/restart" >&2
  exit 1
fi

release_dir="${deploy_path}/releases/${release_id}"
shared_dir="${deploy_path}/shared"
current_link="${deploy_path}/current"
env_file="${shared_dir}/server.env"
service_file="/etc/systemd/system/${service_name}.service"

${SUDO} mkdir -p "${deploy_path}/releases" "${shared_dir}"
${SUDO} rm -rf "${release_dir}"
${SUDO} mkdir -p "${release_dir}"
${SUDO} tar -xzf "${tmp_tgz}" -C "${release_dir}"
${SUDO} ln -sfn "${release_dir}" "${current_link}"

${SUDO} mkdir -p "$(dirname "${data_path}")"
${SUDO} touch "${data_path}"
${SUDO} tee "${env_file}" >/dev/null <<ENV_FILE
REMOTE_LLM_ADDR=${listen_addr}
REMOTE_LLM_DATA_PATH=${data_path}
REMOTE_LLM_RUNTIME_CONFIG=${runtime_config_path}
ENV_FILE

${SUDO} chmod +x "${current_link}/bin/remote-llm-server" "${current_link}/bin/run-remote-llm-server.sh"
${SUDO} chown -R "${run_user}:${run_group}" "${deploy_path}"

${SUDO} tee "${service_file}" >/dev/null <<SERVICE_UNIT
[Unit]
Description=remote-llm controller server
After=network.target

[Service]
Type=simple
User=${run_user}
Group=${run_group}
WorkingDirectory=${current_link}
EnvironmentFile=${env_file}
ExecStart=${current_link}/bin/run-remote-llm-server.sh
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
SERVICE_UNIT

${SUDO} systemctl daemon-reload
${SUDO} systemctl enable "${service_name}" >/dev/null 2>&1 || true
${SUDO} systemctl restart "${service_name}"

health_check_cmd() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "${healthcheck_url}" >/dev/null
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O - "${healthcheck_url}" >/dev/null
    return
  fi
  return 1
}

for i in $(seq 1 30); do
  if health_check_cmd; then
    echo "health check passed (${healthcheck_url})"
    break
  fi
  if [ "${i}" -eq 30 ]; then
    echo "health check failed after retries: ${healthcheck_url}" >&2
    ${SUDO} journalctl -u "${service_name}" -n 120 --no-pager || true
    exit 1
  fi
  sleep 2
done

if [ "${keep_releases}" -gt 0 ] 2>/dev/null; then
  mapfile -t all_releases < <(ls -1dt "${deploy_path}"/releases/* 2>/dev/null || true)
  if [ "${#all_releases[@]}" -gt "${keep_releases}" ]; then
    for old_release in "${all_releases[@]:${keep_releases}}"; do
      ${SUDO} rm -rf "${old_release}"
    done
  fi
fi

${SUDO} rm -f "${tmp_tgz}"
${SUDO} systemctl --no-pager --full status "${service_name}" | sed -n '1,30p'
REMOTE_SCRIPT

echo "deploy completed for ${remote}"
