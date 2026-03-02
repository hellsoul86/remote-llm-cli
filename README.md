# remote-llm-cli

Universal remote controller for agent CLIs over SSH.

Current runtime support:

- `codex` (implemented)
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
- `codex` runtime adapter:
  - `exec` / `exec resume` / `exec review` modes
  - advanced flags (`model`, `sandbox`, `json`, `ephemeral`, `skip-git-repo-check`, etc.)
  - probe diagnostics (`codex --version`, `codex login status`)
- Template runtime adapter SDK (`run_args` placeholders + config loading)
- Host CRUD API (JSON file persistence)
- Host probe (`ssh` + codex diagnostics)
- Multi-host fanout execution (`POST /v1/run` with `host_ids` or `all_hosts`)
- Multi-host file sync over rsync (`POST /v1/sync`)
- Retry policy for run/sync (`retry_count`, `retry_backoff_ms`)
- Safe output capture limit (`max_output_kb`, includes truncation metadata in response)
- Run history API (`GET /v1/runs`)
- Audit event API (`GET /v1/audit`)
- Go TUI CLI for terminal-first operations (`server/cmd/remote-llm-cli`)
- Web console MVP (health, runtime list, host list/add)

## TUI controls

- `q`: quit
- `R`: reload hosts + history
- `r`: execute run
- `h`: reload run/audit history
- `Tab`: switch pane (`control` / `runs` / `audit`)
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

## Docs

- [requirements-v0](docs/requirements-v0.md)
- [universal-agent-cli-v1](docs/universal-agent-cli-v1.md)
