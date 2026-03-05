# Codex CLI Parity Roadmap (WebCLI)

## Goal

Align WebCLI with the real Codex CLI user experience, while keeping controller architecture (`job + SSE`) internal and invisible to users.

Execution tracking:

- UX contract: `docs/codex-native-ux-contract-v1.md`
- Epic: #137

This document defines:

- what Codex CLI can do (baseline),
- what WebCLI already supports,
- what gaps remain,
- phased implementation order.

## Baseline

Reference binary on staging controller host:

- `codex-cli 0.107.0`

Reference command families (from `codex --help` and subcommand helps):

- interactive/root options (`model`, `sandbox`, approval policy, `--search`, `--add-dir`, image attach, profile/config/feature toggles)
- `exec` / `exec resume` / `exec review`
- `resume` / `fork`
- `login` / `logout` / `login status`
- `mcp` server management (`list/get/add/remove/login/logout`)
- `cloud` task lifecycle (`exec/status/list/diff/apply`) [experimental]

## Parity Scope

In scope first:

- session-first Codex UX parity in web (projects, sessions, chat, streaming, model/sandbox/image, resume/fork/review workflows)
- user-facing controls that directly affect Codex behavior

Out of scope for first parity wave:

- shell completion generation
- `sandbox` subcommand wrappers (OS sandbox launcher)
- app-server protocol tooling
- low-level debug tooling

## Feature Matrix

Legend:

- `✅` implemented
- `🟡` partial
- `❌` missing

| Area | Codex CLI Capability | WebCLI Status | Notes |
| --- | --- | --- | --- |
| Session chat | Streaming interactive conversation | ✅ | SSE + session cursor resume in place |
| Session list | Resume existing sessions by project/workdir | ✅ | Host -> Project(path) -> Session tree |
| Session title | Auto title updates | ✅ | Uses `session.title.updated` event |
| Background completion | Non-active session completion reminder | ✅ | Notification + in-app alert |
| Composer | Enter send / Shift+Enter newline | ✅ | Implemented |
| Attach image | `--image` | 🟡 | Supported, currently only for local-mode targets |
| Model select | `--model` | ✅ | Discovered model catalog + per-session model |
| Sandbox select | `--sandbox` | ✅ | Per-session selector in chat pane |
| Approval policy | `--ask-for-approval` | ✅ | Session-level selector in composer advanced panel |
| Web search | `--search` | ✅ | Session-level toggle in composer advanced panel |
| Extra writable dirs | `--add-dir` | ✅ | Session-level add/remove controls in composer advanced panel |
| Profile/config flags | `--profile`, `-c`, `--enable`, `--disable` | ❌ | Not exposed in chat UX |
| Exec mode | `codex exec` | ✅ | Main session send flow |
| Resume mode | `codex exec resume` / `codex resume` | ✅ | Session mode selector + resume target controls |
| Fork mode | `codex fork` | ✅ | Session fork action integrated in composer controls |
| Review mode | `codex review` / `exec review` | ✅ | Session mode selector + review options |
| Ephemeral | `--ephemeral` | ✅ | Advanced toggle mapped into codex request |
| Skip git check | `--skip-git-repo-check` | ✅ | Advanced toggle mapped into codex request |
| JSON output | `--json` | ✅ | Advanced toggle mapped into codex request |
| Login visibility | `codex login status` | ✅ | Dedicated Ops platform auth panel (status/device login/logout) |
| MCP mgmt | `codex mcp ...` | ✅ | Dedicated Ops platform MCP panel (list/get/add/remove/login/logout) |
| Cloud tasks | `codex cloud ...` | ✅ | Dedicated Ops platform cloud panel (list/status/exec/diff/apply) |

## Implementation Phases

### Phase P0: Core Session Parity

Deliver user-facing controls required for day-to-day Codex usage in chat sessions:

- approval policy selector (session-level)
- web search toggle (session-level)
- add writable directories control (session-level)
- expose ephemeral / skip-git-repo-check / json-output as explicit advanced toggles
- keep UI minimal (collapsed "Advanced" section)

### Phase P1: Session Lifecycle Parity

- explicit resume selector flow (resume by session id / last)
- fork-from-session flow
- review mode entry (branch/base/commit oriented workflow)

### Phase P2: Platform Parity

- codex login status/actions in host/session context
- MCP configuration management panel
- experimental Codex Cloud task pane

## UX Rules For Parity Work

- no `job`/`run id` mental model in session mode UI
- session pane stays focused: chat content first, controls minimal and contextual
- advanced options hidden by default, but complete when expanded
- non-active session completion must remain reliable and visible
