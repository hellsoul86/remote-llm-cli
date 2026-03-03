# Merge-Triggered Deploy

This repository supports auto-deploy after merge via GitHub Actions:

- merge/push to `staging` -> deploy to GitHub Environment `staging`
- merge/push to `main` -> deploy to GitHub Environment `production`

Workflow file: `.github/workflows/deploy.yml`

## 1. Target host prerequisites

Each target server should have:

1. Linux with `systemd`
2. `tar`
3. `curl` or `wget` (for health check)
4. `sudo` with non-interactive privilege for deploy user (`sudo -n`)
5. SSH connectivity from GitHub Actions runner

## 2. GitHub Environment configuration

Create two environments in GitHub:

1. `staging`
2. `production`

Set the following in each environment.

### 2.1 Variable: `DEPLOY_TARGETS`

`DEPLOY_TARGETS` is a JSON array. Each item is one host target:

```json
[
  {
    "name": "prod-a",
    "host": "203.0.113.10",
    "port": 22,
    "user": "ecs-user",
    "deploy_path": "/opt/remote-llm-cli",
    "service_name": "remote-llm-server",
    "addr": ":8080",
    "data_path": "/opt/remote-llm-cli/shared/state.json",
    "runtime_config_path": "/opt/remote-llm-cli/shared/runtimes.json",
    "healthcheck_url": "http://127.0.0.1:8080/v1/healthz",
    "web_root": "/var/www/remote-llm",
    "web_reload_cmd": "systemctl reload nginx",
    "keep_releases": 5
  }
]
```

Required keys per item:

- `name`
- `host`
- `user`

Optional keys:

- `port` (default `22`)
- `deploy_path` (default `/opt/remote-llm-cli`)
- `service_name` (default `remote-llm-server`)
- `addr` (default `:8080`)
- `data_path` (default `${deploy_path}/shared/state.json`)
- `runtime_config_path` (default empty)
- `healthcheck_url` (default `http://127.0.0.1:8080/v1/healthz`)
- `keep_releases` (default `5`)
- `web_root` (optional static site publish directory, e.g. `/var/www/remote-llm`)
- `web_reload_cmd` (optional command after web publish, e.g. `systemctl reload nginx`)

`web_root` must be a dedicated static directory (the deploy script rejects unsafe system paths like `/`, `/var`, `/usr`).

### 2.2 Secret: `DEPLOY_SSH_PRIVATE_KEY`

SSH private key content used by workflow to connect target hosts.

## 3. Deployment behavior

Per workflow run:

1. Build release artifact once (`remote-llm-server`, `remote-llm-admin`, startup wrapper script, and `web/dist`).
2. Fan out deploy over host matrix from `DEPLOY_TARGETS`.
3. Upload artifact to target host via SSH/SCP.
4. Extract to release directory: `${deploy_path}/releases/<git-sha>`.
5. Atomically switch `${deploy_path}/current` symlink to new release.
6. Write `${deploy_path}/shared/server.env`.
7. Create/update `systemd` service unit and restart.
8. If `web_root` is configured, publish static files to `web_root` and optionally execute `web_reload_cmd`.
9. Health-check with retries.
10. Keep only latest `keep_releases` release directories.

## 4. Manual redeploy

Workflow also supports manual trigger (`workflow_dispatch`) with:

1. `environment`: `staging` or `production`
2. `ref` (optional): branch/tag/sha to deploy
