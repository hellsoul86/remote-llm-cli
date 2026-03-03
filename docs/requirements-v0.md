# Requirements v0

## 1. Problem

Need one local CLI to control multiple remote servers and run workflows nearly like local development, with a runtime architecture that can support multiple agent CLIs.

## 2. Goals

- Control multiple hosts from one terminal.
- Keep command execution simple and predictable.
- Enable day-1 productivity with minimal setup (SSH key + host config).
- Preserve operation logs for traceability.
- Keep runtime integration generic (`codex`, `claude`, `gemini`, etc.).

## 3. Non-goals (v0)

- No always-on remote agent.
- No distributed scheduler.
- No full replacement of configuration tools (Ansible, Terraform).

## 4. Core user stories

1. As an operator, I can register hosts and list their state.
2. As an operator, I can execute one command on one host.
3. As an operator, I can execute one command on multiple hosts concurrently.
4. As an operator, I can sync local project files to a remote workspace.
5. As an operator, I can open an interactive shell into a host workspace.
6. As an operator, I can see per-host exit code and stdout/stderr summary.

## 5. Functional requirements

## 5.0 Runtime abstraction

- The system must expose a runtime selector (e.g. `--runtime codex`).
- Runtime execution logic must be adapter-based, not hardcoded.
- v0 implementation scope: only `codex` runtime adapter is required.

## 5.1 Host inventory

- Config file path: `~/.config/remote-llm-cli/hosts.yaml` (default).
- Fields per host:
  - `name`
  - `connection_mode` (`ssh` default, `local` optional)
  - `host` (required for `ssh`, optional for `local`)
  - `user`
  - `port` (default 22)
  - `identity_file` (optional)
  - `workspace` (remote base dir)
  - `tags` (optional)

## 5.2 Commands

- `remote-llm hosts list`
- `remote-llm exec --host <name> -- <cmd>`
- `remote-llm exec --all --fanout <n> -- <cmd>`
- `remote-llm run --host <name> --runtime codex --prompt "<text>"`
- `remote-llm run --all --runtime codex --fanout <n> --prompt "<text>"`
- `remote-llm sync --host <name> --src <local> --dst <remote>`
- `remote-llm shell --host <name>`

## 5.3 Output model

- For single host: stream raw output.
- For multi-host: prefix each line with host name.
- End summary table:
  - host
  - exit code
  - duration
  - status

## 5.4 Error handling

- SSH connect/auth failures are explicit and per-host.
- Multi-host command does not hide partial failures.
- Non-zero remote exit returns non-zero controller exit.

## 6. Security requirements

- No plaintext secrets in repo config.
- Prefer SSH keys, not password prompts in automation mode.
- Disable SSH agent forwarding by default.
- Optional allowlist for high-risk commands.
- Local audit log for command + target + timestamp + result.

## 7. Suggested implementation (v0)

- Language: Go (backend) + TypeScript (web).
- SSH transport: native `ssh` command invocation first (simple/reliable).
- Sync: `rsync` with include/exclude support.
- Connection reuse: SSH ControlMaster/ControlPersist.

## 8. Milestones

1. M1: host inventory + single-host `exec`
2. M2: runtime abstraction + `codex` adapter (single-host)
3. M3: multi-host `exec/run --all --fanout`
4. M4: `sync` and `shell`
5. M5: audit log + retry policy

## 9. Open decisions

1. Remote workspace convention (fixed path or per-project dynamic path)?
2. Need sudo/escalation support in v0?
3. Need Windows target support in v0?
