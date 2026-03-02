# remote-llm-cli

Universal remote controller for agent CLIs over SSH.

Current runtime support:

- `codex` (implemented)
- `claude` (planned adapter)
- `gemini` (planned adapter)

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
- `codex` runtime adapter (`probe` + remote `codex exec`)
- Host CRUD API (JSON file persistence)
- Host probe (`ssh` + `codex --version`)
- Multi-host fanout execution (`POST /v1/run` with `host_ids` or `all_hosts`)
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

## Workflow

This repo follows issue-first delivery:

- Issue templates: `.github/ISSUE_TEMPLATE/`
- PR template: `.github/pull_request_template.md`
- Breakdown: [docs/issue-pr-breakdown.md](docs/issue-pr-breakdown.md)

## Docs

- [requirements-v0](docs/requirements-v0.md)
- [universal-agent-cli-v1](docs/universal-agent-cli-v1.md)
