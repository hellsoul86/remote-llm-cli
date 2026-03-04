# Codex CLI Parity Roadmap (WebCLI)

## Goal

Align WebCLI with the real Codex CLI user experience, while keeping controller architecture (`job + SSE`) internal and invisible to users.

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
| Approval policy | `--ask-for-approval` | ❌ | Not exposed in UI or request payload |
| Web search | `--search` | ❌ | Not exposed |
| Extra writable dirs | `--add-dir` | ❌ | Not exposed in chat UX |
| Profile/config flags | `--profile`, `-c`, `--enable`, `--disable` | ❌ | Not exposed in chat UX |
| Exec mode | `codex exec` | ✅ | Main session send flow |
| Resume mode | `codex exec resume` / `codex resume` | 🟡 | Backend supports; session UX not explicitly exposing resume selector flow |
| Fork mode | `codex fork` | ❌ | No web workflow yet |
| Review mode | `codex review` / `exec review` | ❌ | Backend supports; no dedicated web review UX |
| Ephemeral | `--ephemeral` | 🟡 | Hardcoded false in session flow; no UI toggle |
| Skip git check | `--skip-git-repo-check` | 🟡 | Hardcoded true in session flow; no UI toggle |
| JSON output | `--json` | 🟡 | Hardcoded true in session flow |
| Login visibility | `codex login status` | 🟡 | Visible via host probe diagnostics only, not session-facing |
| MCP mgmt | `codex mcp ...` | ❌ | Not exposed |
| Cloud tasks | `codex cloud ...` | ❌ | Not exposed |

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

