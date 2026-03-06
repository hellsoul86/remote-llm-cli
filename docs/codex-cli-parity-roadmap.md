# Codex App Parity Roadmap (WebCLI)

## Goal

Align WebCLI with the native Codex app interaction model first, while treating CLI option coverage as secondary support work.

Execution tracking:

- UX contract: `docs/codex-native-ux-contract-v2.md`
- Epic: #137
- Reset/design issue: #192

This document defines:

- what the native Codex experience should feel like,
- which Codex controls still matter in web,
- where current WebCLI still deviates,
- the phased order to close those gaps.

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

- session-first Codex app parity in web (projects, sessions, chat, streaming, model/sandbox/image, resume/fork/review workflows)
- user-facing controls that directly affect Codex behavior, but only when they fit a native-feeling session shell
- interaction calmness: low-noise chrome, contextual actions, and background sync that stays out of the way

Out of scope for first parity wave:

- shell completion generation
- `sandbox` subcommand wrappers (OS sandbox launcher)
- app-server protocol tooling
- low-level debug tooling

Primary acceptance is no longer raw option coverage. The web shell must feel close to the macOS app baseline before parity is claimed.

## Capability Matrix

Legend:

- `✅` implemented
- `🟡` partial
- `❌` missing

| Area | Codex Capability | WebCLI Status | Notes |
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
| Login visibility | `codex login status` | 🟡 | Implemented, but still too coupled to the main shell |
| MCP mgmt | `codex mcp ...` | 🟡 | Implemented, but should move to secondary utility surfaces |
| Cloud tasks | `codex cloud ...` | 🟡 | Implemented, but should not shape the primary session workspace |

## Native Gap Reset

Current high-priority UX gaps relative to the native target:

1. Primary shell still feels like a controller dashboard.
2. Sidebar is too CRUD-heavy and not compact enough as navigation.
3. Session header exposes transport mechanics too prominently.
4. Composer exposes too many settings in the default path.
5. Utility/ops surfaces are too close to the core chat workflow.

## Implementation Phases

### Phase P0: Shell Reduction

- demote controller/ops chrome out of the primary session shell
- make the session workbench visually dominant
- remove acceptance language that rewards exposed controls over interaction quality

### Phase P1: Sidebar Parity

- compress host/project/session navigation
- move project/session management into contextual actions
- strengthen running/unread/background completion states

### Phase P2: Session Workbench Parity

- simplify session header to title + minimal context
- keep timeline content-first and low-noise
- redesign composer so model/permission/image are compact and contextual
- keep rare flags behind a secondary surface

### Phase P3: Utility Surface Parity

- move auth, MCP, cloud, and diagnostics into secondary surfaces
- ensure these remain reachable without becoming the app's primary mental model

## UX Rules For Parity Work

- no `job`/`run id` mental model in session mode UI
- session pane stays focused: chat content first, controls minimal and contextual
- advanced options hidden by default, but complete when expanded
- non-active session completion must remain reliable and visible
- a feature is not considered parity-complete if it makes the main shell feel more like an admin console than a native session workspace
