# remote-llm-cli

Universal remote controller for agent CLIs over SSH.

Current runtime support:

- `codex` (implemented)
- `claudecode` (built-in v2 adapter baseline)
- template-based custom runtimes via JSON config (adapter SDK)

## Stack

- Backend: Go (`server/`)
- Frontend: TypeScript + React + Vite (`web/`)

## Quickstart

1. Create an access key:

```bash
make key-create
```

2. Start API server:

```bash
make server-run
```

Optional: start server with external runtime definitions:

```bash
cd server
go run ./cmd/remote-llm-server \
  --addr :8080 \
  --data ./data/state.json \
  --runtime-config ../examples/runtimes.example.json
```

3. Start web console:

```bash
make web-install
make web-dev
```

4. Start TUI CLI (terminal mode):

```bash
export REMOTE_LLM_KEY="rlm_xxx.yyy"
make tui-run
```

Default API URL is `http://localhost:8080`.

## Current capabilities

- Access-key auth (`Bearer`)
- Runtime registry abstraction
- Runtime adapter contract v2 metadata (`version`, `prompt_required`, `supports_workdir`, `supports_extra_args`)
- `codex` runtime adapter:
  - `exec` / `exec resume` / `exec review` modes
  - advanced flags (`model`, `sandbox`, `json`, `ephemeral`, `skip-git-repo-check`, etc.)
  - probe diagnostics (`codex --version`, `codex login status`)
- Template runtime adapter SDK (`run_args` placeholders + config loading)
- Built-in `claudecode` adapter path through the same controller pipeline
- Host CRUD API (JSON file persistence)
- Host probe (`ssh` + codex diagnostics)
- SSH transport hardening per host:
  - `ssh_proxy_jump`
  - `ssh_connect_timeout_sec`
  - `ssh_server_alive_interval_sec`
  - `ssh_server_alive_count_max`
  - `ssh_host_key_policy` (`accept-new` / `strict` / `insecure-ignore`)
- Structured transport error classification (`error_class`, `error_hint`) for run/sync/probe targets
- Probe preflight checks for controller toolchain and SSH key accessibility
- Multi-host fanout execution (`POST /v1/run` with `host_ids` or `all_hosts`)
- Async run jobs with reconnectable polling (`POST /v1/jobs/run`, `GET /v1/jobs`, `GET /v1/jobs/{id}`)
- Multi-host file sync over rsync (`POST /v1/sync`)
- Async sync jobs on the same scheduler (`POST /v1/jobs/sync`)
- Job cancellation API (`POST /v1/jobs/{id}/cancel`)
- Codex session discovery and cleanup (`POST /v1/codex/sessions/discover`, `POST /v1/codex/sessions/cleanup`)
- Filterable jobs and audit APIs (`status`/`runtime`/`type`/`host_id`/time range)
- Retention policy API for runs/jobs/audit (`GET/POST /v1/admin/retention`)
- Metrics API for queue depth, worker utilization, and success rate (`GET /v1/metrics`)
- Retry policy for run/sync (`retry_count`, `retry_backoff_ms`)
- Safe output capture limit (`max_output_kb`, includes truncation metadata in response)
- Run history API (`GET /v1/runs`)
- Audit event API (`GET /v1/audit`)
- Go TUI CLI for terminal-first operations (`server/cmd/remote-llm-cli`)
- Web console MVP (health, runtime list, host list/add)
- Operational runbook: [`docs/operations-runbook.md`](docs/operations-runbook.md)
- Merge-triggered deploy workflow: [`docs/deployment-github-actions.md`](docs/deployment-github-actions.md)

## TUI controls

- `q`: quit
- `R`: reload hosts + history
- `r`: execute run
- `u`: toggle run mode (`async job` / `sync request`)
- `h`: reload run/audit history
- `Tab`: switch pane (`control` / `runs` / `audit` / `jobs`)
- `J`: reload jobs list (in `jobs` pane)
- `Enter` / `w`: watch selected job (in `jobs` pane)
- `c`: cancel selected running/pending job (in `jobs` pane)
- `v`: load latest resumable codex session from current host into resume config
- `a`: toggle all-host mode
- `space`: toggle selected host (when all-host mode is off)
- `p`: edit prompt
- `w`: edit workdir override
- `+` / `-`: adjust fanout
- `[` / `]`: decrease/increase max output KB
- `.` / `,`: increase/decrease retry count
- `n` / `b`: increase/decrease retry backoff ms
- `t`: cycle codex mode (`exec`/`resume`/`review`)
- `m`: edit codex model
- `x`: cycle codex sandbox
- `y`: toggle `codex --json`
- `g`: toggle `--skip-git-repo-check`
- `e`: toggle `--ephemeral`
- `l`: toggle resume `--last`
- `s`: edit resume session id (when `resume_last=false`)
- `o`: open interactive SSH shell on current host (with workspace cd)

## Fanout API example

```bash
curl -X POST http://localhost:8080/v1/run \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "codex",
    "all_hosts": true,
    "fanout": 3,
    "prompt": "summarize git status and risks"
  }'
```

## Host SSH hardening fields

Host upsert accepts optional SSH transport settings:

```json
{
  "name": "prod-a",
  "host": "10.0.0.12",
  "user": "ecs-user",
  "identity_file": "/home/ecs-user/.ssh/id_ed25519",
  "ssh_proxy_jump": "jump@bastion:22",
  "ssh_connect_timeout_sec": 15,
  "ssh_server_alive_interval_sec": 30,
  "ssh_server_alive_count_max": 3,
  "ssh_host_key_policy": "strict"
}
```

`POST /v1/hosts/{id}/probe` also supports optional body:

```json
{
  "preflight": true
}
```

Probe response includes `preflight.checks[]`, and command failures include `error_class` + `error_hint`.

## Async Run Job API example

```bash
# enqueue
curl -X POST http://localhost:8080/v1/jobs/run \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "codex",
    "all_hosts": true,
    "fanout": 3,
    "prompt": "summarize git status and blockers"
  }'

# poll list
curl -X GET "http://localhost:8080/v1/jobs?limit=20" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"

# poll one
curl -X GET "http://localhost:8080/v1/jobs/job_xxx" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"

# cancel one
curl -X POST "http://localhost:8080/v1/jobs/job_xxx/cancel" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"
```

## Async Sync Job API example

```bash
curl -X POST http://localhost:8080/v1/jobs/sync \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "all_hosts": true,
    "fanout": 3,
    "src": "./",
    "dst": "workspace",
    "delete": false,
    "excludes": [".git", "node_modules"],
    "retry_count": 1,
    "retry_backoff_ms": 1000
  }'
```

## Codex Session Ops API example

```bash
# discover sessions for one host
curl -X POST http://localhost:8080/v1/codex/sessions/discover \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "host_id": "h_123",
    "limit_per_host": 10
  }'

# cleanup old session files (dry run)
curl -X POST http://localhost:8080/v1/codex/sessions/cleanup \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "all_hosts": true,
    "older_than_hours": 168,
    "dry_run": true
  }'
```

## Jobs & Audit Filter API example

```bash
# jobs: only failed+running sync/codex jobs for one host
curl -X GET "http://localhost:8080/v1/jobs?limit=100&status=failed,running&type=run,sync&runtime=codex,sync&host_id=h_123" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"

# audit: only cancel events with 2xx status
curl -X GET "http://localhost:8080/v1/audit?limit=100&action=job.cancel&status=200" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"
```

## Metrics & Retention API example

```bash
# metrics snapshot
curl -X GET "http://localhost:8080/v1/metrics" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"

# read retention policy
curl -X GET "http://localhost:8080/v1/admin/retention" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY"

# update retention policy
curl -X POST "http://localhost:8080/v1/admin/retention" \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "run_records_max": 1000,
    "run_jobs_max": 5000,
    "audit_events_max": 10000
  }'
```

## Codex advanced run example

```bash
curl -X POST http://localhost:8080/v1/run \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "runtime": "codex",
    "all_hosts": true,
    "fanout": 2,
    "prompt": "continue implementing tests",
    "max_output_kb": 512,
    "codex": {
      "mode": "resume",
      "resume_last": true,
      "model": "gpt-5",
      "json_output": true,
      "ephemeral": false,
      "skip_git_repo_check": true
    }
  }'
```

## Sync API example

```bash
curl -X POST http://localhost:8080/v1/sync \
  -H "Authorization: Bearer $REMOTE_LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "all_hosts": true,
    "fanout": 3,
    "src": "./",
    "dst": "workspace",
    "delete": false,
    "excludes": [".git", "node_modules"],
    "max_output_kb": 256,
    "retry_count": 1,
    "retry_backoff_ms": 1000
  }'
```

## Runtime Adapter SDK

Runtime config file format (JSON):

- top-level `runtimes` array
- each runtime:
  - `name`: runtime key used by API `runtime` field
  - `program`: remote executable
  - `run_args`: command template args
  - `probe_program` / `probe_args` (optional)
  - `capabilities` (optional)
  - `append_extra_args` (optional, default `true`)

Supported placeholders in `run_args`:

- `{{prompt}}`: required prompt text
- `{{workdir}}`: workdir value from run request (errors if empty)
- `{{extra_args}}`: expands `extra_args` list; must be standalone token

Built-in adapters expose contract metadata via `GET /v1/runtimes`:

- `contract.version` (currently `v2`)
- `contract.prompt_required`
- `contract.supports_workdir`
- `contract.supports_extra_args`

Validate runtime config:

```bash
cd server
go run ./cmd/remote-llm-admin runtime validate \
  --config ../examples/runtimes.example.json
```

## Workflow

This repo follows issue-first delivery:

- Issue templates: `.github/ISSUE_TEMPLATE/`
- PR template: `.github/pull_request_template.md`
- Breakdown: [docs/issue-pr-breakdown.md](docs/issue-pr-breakdown.md)
- Governance: [docs/repo-governance.md](docs/repo-governance.md)
- Testing: [docs/testing.md](docs/testing.md)

## Docs

- [requirements-v0](docs/requirements-v0.md)
- [universal-agent-cli-v1](docs/universal-agent-cli-v1.md)
- [testing](docs/testing.md)
- [adapter-authoring](docs/adapter-authoring.md)
