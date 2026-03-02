# Universal Agent CLI Design (v1)

## 1. Product direction

Build a generic remote controller that can drive multiple agent CLIs:

- `codex` (first implementation)
- `claude` (next)
- `gemini` (next)

The core system must not hardcode any one vendor CLI.

## 2. Core principle

Separate **transport** from **agent runtime**:

- Transport layer: SSH, host selection, fanout, logs, retries.
- Runtime layer: how to invoke a specific agent CLI binary.

This keeps 80% of logic reusable when adding new CLIs.

## 3. Architecture

## 3.1 Components

1. `controller-core`
   - host inventory
   - job scheduler
   - execution lifecycle
2. `transport-ssh`
   - remote command execution
   - file sync
3. `runtime-registry`
   - runtime lookup by name (`codex`, `claude`, `gemini`)
4. `runtime adapters`
   - adapter-specific command builder and parsing
5. `auth + audit`
   - access key validation
   - operation logs

## 3.2 Runtime interface

Each runtime adapter implements the same interface:

- `name() -> string`
- `probe(host) -> RuntimeProbeResult`
- `build_exec(request) -> RemoteCommand`
- `parse_result(raw) -> NormalizedResult`
- `capabilities() -> RuntimeCapabilities`

Normalized request/response must be runtime-agnostic.

## 4. Unified data model

## 4.1 Runtime request

- `runtime`: `codex | claude | gemini | ...`
- `task_type`: `exec | review | patch` (extensible)
- `prompt`
- `workdir`
- `extra_args`
- `timeout_sec`

## 4.2 Runtime result

- `status`: `ok | failed | timeout | canceled`
- `exit_code`
- `stdout`
- `stderr`
- `artifacts` (optional)
- `usage` (optional normalized token/cost fields)

## 5. Codex-first implementation scope

v1 only implements `codex` adapter with:

1. `probe`
   - check `codex --version`
2. `exec`
   - run `codex exec ...` remotely
3. result capture
   - stdout/stderr
   - exit code

Out of scope in first cut:

- interactive session attach
- slash-command parity
- full transcript sync semantics

## 6. CLI command design

Example command shape:

```bash
remote-llm run \
  --host dev-a \
  --runtime codex \
  --prompt "fix failing tests in this repo" \
  --workdir /home/ecs-user/project
```

Multi-host:

```bash
remote-llm run \
  --all \
  --fanout 5 \
  --runtime codex \
  --prompt "summarize git status and risks" \
  --workdir /srv/app
```

## 7. Capability flags

Each runtime declares capabilities so UI/CLI can gate features:

- `supports_non_interactive_exec`
- `supports_interactive_session`
- `supports_structured_output`
- `supports_file_patch_mode`
- `supports_cost_metrics`

`codex` initial profile:

- non-interactive exec: yes
- interactive session: later
- structured output: partial
- file patch mode: later
- cost metrics: optional

## 8. Security model

Single-user, access-key-first:

- Bearer access key for controller API
- SSH key auth for remote hosts
- audit per request + per host target

Sensitive values must be redacted in logs.

## 9. Milestones

1. M1: Core framework + runtime interface + `codex` adapter
2. M2: Multi-host fanout + normalized results
3. M3: API/Web integration on top of runtime registry
4. M4: `claude`/`gemini` adapters

## 10. Open design checks

1. Should `runtime` be required on every run, or host-level default?
2. Need per-runtime environment injection (`OPENAI_API_KEY`, etc.) in v1?
3. Do we want adapter-specific args passthrough in v1?

## 11. Runtime SDK (current implementation)

Current implementation supports template-driven adapters loaded from JSON at server startup.

- CLI flag: `remote-llm-server --runtime-config <path>`
- template placeholders in `run_args`:
  - `{{prompt}}`
  - `{{workdir}}`
  - `{{extra_args}}`
- validation command:
  - `remote-llm-admin runtime validate --config <path>`
