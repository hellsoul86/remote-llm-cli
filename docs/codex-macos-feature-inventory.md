# Codex macOS Feature Inventory

Scope date: 2026-03-07 (Asia/Shanghai)
Primary source set:

- https://developers.openai.com/codex/app
- https://developers.openai.com/codex/app/features
- https://developers.openai.com/codex/app/settings
- https://developers.openai.com/codex/app/review
- https://developers.openai.com/codex/app/automations
- https://developers.openai.com/codex/app/worktrees
- https://developers.openai.com/codex/app/local-environments
- https://developers.openai.com/codex/app/commands
- https://developers.openai.com/codex/app-server

The public `codex` repository does not ship the macOS app UI source. It does ship the launcher, CLI/TUI behavior, app-server protocol, and tests, so this inventory combines official docs plus protocol evidence.

## Source-of-truth Surfaces

### 1. App shell and navigation

Official docs and screenshots show a compact native workbench shell with:

- left rail navigation for projects/threads
- a single active workbench as the visual center
- secondary panes for review and terminal
- no controller/transport/debug concepts in the happy path
- keyboard-driven navigation and command menu

### 2. Project and thread management

Documented or protocol-backed capabilities:

- create or continue project-scoped threads
- thread list and loaded-thread list
- rename thread
- archive and unarchive thread
- fork thread
- resume thread
- background thread completion notifications
- archived-thread recovery via filters/search
- auto title updates from thread lifecycle events

Relevant protocol/app-server methods:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/archive`
- `thread/unarchive`
- `thread/name/set`
- `thread/compact/start`
- `thread/rollback`

### 3. Conversation workbench

Official docs show the conversation area is content-first:

- thread title and minimal project/worktree context
- assistant and user content with very light metadata
- inline approvals when action is required
- background completion indicators outside the main chat flow
- one active thread at a time

Official docs also describe:

- local chat context and worktree context
- background delegations that continue while the user switches threads
- notifications when background work finishes

### 4. Composer and command surfaces

Official docs and CLI/TUI references indicate support for:

- plain prompt input as the primary affordance
- image attach / paste / drop
- slash commands
- keyboard shortcuts
- model selection
- permission / approval control
- mode switching across local, worktree, and cloud when available
- skill invocation (`$skill` pattern in official command docs)

Current official command references called out in docs:

- `/feedback`
- `/mcp`
- `/plan-mode`
- `/review`
- `/status`

Protocol-backed related surfaces:

- `model/list`
- `experimentalFeature/list`
- `collaborationMode/list`
- `skills/list`
- `skills/remote/list`
- `tool/requestUserInput`
- config read/write methods

### 5. Review pane

Official review docs show a dedicated review surface with:

- file-level diff navigation
- inline comments / review notes
- dismiss / stage / revert type actions
- a dedicated shortcut to toggle the diff pane
- review integrated into the thread workbench, not dumped into chat text

Relevant protocol/app-server evidence:

- `review/start`
- thread items and turn items carry structured output suitable for a review pane

### 6. Integrated terminal

Official feature docs show an integrated terminal drawer with:

- dedicated toggle shortcut
- bottom-docked terminal surface
- terminal as a workspace tool, not a timeline message
- live shell output alongside an active thread

Protocol note:

- app-server docs mention experimental background terminal cleanup and realtime thread APIs; the public docs confirm terminal is a first-class app surface, not just CLI stdout embedded in chat.

### 7. Worktrees and local environments

Official worktree docs show:

- worktree-focused thread mode
- branch/worktree context in the header
- handoff / open locally style actions
- continue work from local environments
- project actions associated with an environment or worktree

Official local environments docs show:

- environment actions rendered in the workbench
- ability to associate actions such as run/test/open
- environment-aware project behavior

### 8. Notifications and background work

Official app docs explicitly position the app as a place to delegate long-running tasks and receive notifications when they finish. Required behaviors implied by docs:

- inactive threads continue in background
- completion is surfaced without re-opening the thread
- notifications do not spam historical completions
- unread/completion state belongs in navigation, not the chat transcript

### 9. Settings, skills, and utility surfaces

Official docs expose:

- settings and personalization
- skills and remote skills
- MCP setup and management
- app and app-list update surfaces
- account / rate limit status
- feedback upload

These are app capabilities, but they are not the primary workbench view.

### 10. Automations and cloud

Official docs expose:

- automations page / scheduled work
- cloud mode or cloud-backed task flow where available
- queue / delegated work mental model outside the active thread shell

These are part of the app, but they are separate surfaces from the day-to-day thread workbench.

### 11. Pop-out and windowing behavior

Official docs mention:

- pop-out thread windows
- stay-on-top support

These are secondary workflow enhancements, not blockers for the first parity wave.

## Official Keyboard and Interaction Baseline

Documented keyboard surfaces include:

- command menu
- settings
- open folder/project
- sidebar toggle
- diff pane toggle
- terminal toggle
- new thread
- in-thread find
- thread navigation
- slash-command entry from the composer

Web parity should implement platform-equivalent shortcuts using `Ctrl` on non-macOS platforms.

## Visual Baseline

From official screenshots and docs:

- the shell is calm, not dashboard-like
- typography is close to the SF Pro family / macOS system feel
- color palette is mostly white, soft gray, and black CTA with restrained status colors
- surfaces are rounded and layered, but without loud gradients or decorative noise
- sidebar is compact and dense
- review and terminal are clear secondary panes, not separate admin screens

## Parity Classification for This Project

Blocking for first implementation milestone:

- single workbench shell
- compact project/thread navigation
- content-first thread timeline
- composer redesign
- review pane
- terminal drawer
- background completion and unread fidelity
- keyboard parity for the core workbench

Design-now, implement-later:

- automations page
- settings modal and full personalization suite
- skills browser and remote skill import/export
- cloud mode execution surface
- pop-out windows and stay-on-top

Do-not-ship-as-dead-controls:

- voice/dictation
- cloud mode
- pop-out
- settings entries with no backing behavior
