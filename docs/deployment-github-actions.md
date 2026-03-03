# Merge-Triggered Deploy

This repository deploys with one workflow (`.github/workflows/deploy.yml`) after merge/push:

- `staging` -> GitHub Environment `staging`
- `main` -> GitHub Environment `production`

Deploy strategy:

- API: SSH deploy to target servers (`remote-llm-server` systemd service)
- Web: deploy `web/dist` to Cloudflare Pages

## 1. API deploy configuration (SSH)

### 1.1 Host prerequisites

Each API target server should have:

1. Linux with `systemd`
2. `tar`
3. `curl` or `wget` (for health check)
4. `sudo -n` capability for deploy user
5. SSH reachable from GitHub Actions runner

### 1.2 Environment secret: `DEPLOY_TARGETS`

Set `DEPLOY_TARGETS` secret value as JSON array:

```json
[
  {
    "name": "api-prod-a",
    "host": "203.0.113.10",
    "port": 22,
    "user": "ecs-user",
    "deploy_path": "/opt/remote-llm-cli",
    "service_name": "remote-llm-server",
    "addr": ":8080",
    "data_path": "/opt/remote-llm-cli/shared/state.json",
    "runtime_config_path": "/opt/remote-llm-cli/shared/runtimes.json",
    "healthcheck_url": "http://127.0.0.1:8080/v1/healthz",
    "keep_releases": 5
  }
]
```

Required keys:

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

### 1.3 Environment secret: `DEPLOY_SSH_PRIVATE_KEY`

Private key content for SSH login to all hosts in `DEPLOY_TARGETS`.

## 2. Web deploy configuration (Cloudflare Pages)

### 2.1 Environment secrets

- `CF_PAGES_PROJECT`: Cloudflare Pages project name (required)
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id (required)
- `CLOUDFLARE_API_TOKEN`: API token with Pages deploy permission (required)

### 2.2 Environment variables

- `VITE_API_BASE`: API base URL injected at web build time (required)
  - example: `https://webcli-api-staging.royding.ai`
- `CF_PAGES_BRANCH`: Pages branch override (optional; default `github.ref_name`)

The deploy workflow will auto-create the Pages project on first deploy if it does not exist.

## 3. Workflow behavior

Per run:

1. Build API release artifact (`remote-llm-server`, `remote-llm-admin`, startup script)
2. Fan out API deployment over `DEPLOY_TARGETS`
3. Upload/extract release, switch `current` symlink, restart systemd, health-check, trim old releases
4. Build web (`web/dist`)
5. Ensure Pages project exists (auto-create when missing)
6. Deploy web to Cloudflare Pages (`wrangler pages deploy`)

## 4. Manual redeploy

`workflow_dispatch` is supported with:

1. `environment`: `staging` or `production`
2. `ref` (optional): branch/tag/sha to deploy
