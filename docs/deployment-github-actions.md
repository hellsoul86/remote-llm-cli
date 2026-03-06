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
    "cors_allow_origins": "https://webcli.staging.royding.ai",
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
- `cors_allow_origins` (default uses `DEPLOY_CORS_ALLOW_ORIGINS` env var if set; otherwise allow-all `*` for backward compatibility)
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

- `DEPLOY_CORS_ALLOW_ORIGINS`: optional default CORS allowlist for API deploy targets
  - example: `https://webcli.staging.royding.ai`
- `VITE_API_BASE`: API base URL injected at web build time (required)
  - example: `https://webcli-api-staging.royding.ai`
- `CF_PAGES_BRANCH`: Pages branch override (optional; default `github.ref_name`)
- `SMOKE_API_BASE`: optional override for post-deploy API smoke target; falls back to `VITE_API_BASE`
- `SMOKE_WEB_BASE`: optional URL for post-deploy web shell smoke

The deploy workflow will auto-create the Pages project on first deploy if it does not exist.

### 2.3 Environment secrets

- `SMOKE_ACCESS_TOKEN`: optional access token for authenticated post-deploy smoke (`GET /v1/projects`)

## 3. Workflow behavior

Per run:

1. Build API release artifact (`remote-llm-server`, `remote-llm-admin`, startup script)
2. Fan out API deployment over `DEPLOY_TARGETS`
3. Upload/extract release, switch `current` symlink, restart systemd, health-check, trim old releases
4. Build web (`web/dist`)
5. Ensure Pages project exists (auto-create when missing)
6. Deploy web to Cloudflare Pages (`wrangler pages deploy`)
7. Run post-deploy smoke:
   - `GET {SMOKE_API_BASE or VITE_API_BASE}/v1/healthz`
   - optional authenticated `GET /v1/projects`
   - optional web shell fetch against `SMOKE_WEB_BASE`

## 4. Manual redeploy

`workflow_dispatch` is supported with:

1. `environment`: `staging` or `production`
2. `ref` (optional): branch/tag/sha to deploy

## 5. Staging soak workflow

`Staging Soak` workflow (`.github/workflows/staging-soak.yml`) is used to collect codex v2 reconnect/cursor continuity evidence.

### 5.1 Environment configuration (`staging`)

Secrets:

- `SOAK_ACCESS_TOKEN`: staging access key for API calls

Variables:

- `SOAK_API_BASE`: staging API base URL (falls back to `VITE_API_BASE` when empty)
- `SOAK_HOST_ID`: host id used for soak session start
- `SOAK_PROJECT_PATH`: project path used for soak session start

### 5.2 Trigger

Run manually with `workflow_dispatch` inputs:

- `duration` (default `2h`)
- `reconnect_window` (default `30s`)
- `prompt_interval` (default `2m`)
- `model` (optional)
- `archive_on_exit` (default `true`)

### 5.3 Output

- Uploads `codex-v2-staging-soak-report` artifact (JSON).
- Publishes summary (`session_id`, `stream`, `turns`, terminal run counts) in workflow step summary.

## 6. Staging live Playwright workflow

`Staging Live E2E` workflow (`.github/workflows/staging-live-e2e.yml`) runs the real web session suite against the deployed staging stack.

### 6.1 Environment configuration (`staging`)

Secrets:

- `E2E_ACCESS_TOKEN`: optional dedicated staging access key for Playwright live e2e
- `SOAK_ACCESS_TOKEN`: fallback access key when `E2E_ACCESS_TOKEN` is not set

Variables:

- `E2E_BASE_URL`: staging web URL
  - example: `https://webcli.staging.royding.ai`
- `VITE_API_BASE`: staging API base URL
  - example: `https://webcli-api-staging.royding.ai`
- `E2E_PROJECT_PATH`: optional default project path for live session creation
  - default used by the suite: `/home/ecs-user`

### 6.2 Trigger

Run manually with `workflow_dispatch` inputs:

- `grep` (optional Playwright grep filter)
- `project_path` (optional override for the live project root)

### 6.3 Behavior

Per run:

1. Install web dependencies
2. Install Playwright Chromium
3. Resolve staging token (`E2E_ACCESS_TOKEN` -> `SOAK_ACCESS_TOKEN` fallback)
4. Run `npm run test:e2e:live`
5. Upload Playwright traces/results as workflow artifacts
