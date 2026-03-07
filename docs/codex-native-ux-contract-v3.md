# Codex Native UX Contract v3

Scope date: 2026-03-07 (Asia/Shanghai)
Primary issue: #201
Supersedes:

- `docs/codex-native-ux-contract-v1.md`
- `docs/codex-native-ux-contract-v2.md`

Supporting references:

- `docs/codex-macos-feature-inventory.md`
- `docs/codex-web-gap-matrix.md`

## Goal

Ship a Codex web workbench that feels structurally and behaviorally close to the official macOS Codex app.

Parity is not accepted by option coverage alone. The web must match the native app in:

- information architecture
- control density
- conversational focus
- background-work behavior
- review and terminal integration
- visual calmness

## Product Positioning

The primary product is a workbench for active Codex threads.

Implications:

1. The user should land in a single workbench, not a dashboard.
2. Projects and threads are primary navigation objects.
3. Host and remote-control metadata are secondary and contextual.
4. Review and terminal are first-class secondary panes inside the workbench.
5. Utility surfaces exist, but they must not define the main shell.

## Information Architecture

### Primary shell

The default shell contains only:

- compact global chrome
- left navigation rail for projects and threads
- one active thread workbench
- contextual secondary panes for review and terminal

The default shell must not expose:

- `job` or `run` mental models
- controller health unless degraded
- transport or stream jargon in the ordinary path
- a primary `Ops` mode toggle

### Remote host treatment

Host is weakened but preserved.

Rules:

- project and thread navigation is primary
- host appears in project metadata, project creation, and workspace switching
- host is not rendered as the main top-level navigation tree
- if multiple projects conflict in title/path, host becomes the disambiguator

### Secondary surfaces

These surfaces are separate from the primary workbench:

- utilities / settings
- MCP management
- automations
- skills browser or management
- cloud-specific workflow surfaces
- feedback and diagnostics

They may use routes, drawers, modals, or panels, but they must not replace the workbench as the default home.

## Workbench Contract

### Sidebar contract

The sidebar is a navigator, not a CRUD panel.

Required behavior:

- show projects first, then threads within each project
- order by `pinned`, `running/unread`, then recency
- show unread/running with compact badges or dots
- create project through a sheet/modal, not an inline management form
- hide rename/archive behind contextual controls
- keep copy terse and non-instructional

Forbidden behavior:

- large management copy blocks
- host-collapse controls as the dominant affordance
- always-visible rename/archive buttons on inactive rows
- persistent notification trays that feel like a console

### Header contract

The header is a context bar, not a transport bar.

Required behavior:

- show active thread title
- show project/worktree context in compressed form
- expose review and terminal as contextual actions when available
- keep connection recovery controls out of the default emphasis

Forbidden behavior:

- `stream live`, `reconnecting`, or similar transport-first wording as the main header identity
- archive/reconnect as primary always-on actions

### Timeline contract

The timeline is content-first.

Required behavior:

- user and assistant messages dominate visually
- timestamps remain light and secondary
- inline approvals render only where action is needed
- auto-scroll stays pinned when the user is at the bottom
- `Jump to latest` appears only when the user has intentionally moved away from the tail
- replayed events never create duplicate assistant completions or notification bursts

Forbidden behavior:

- JSON protocol lines
- runtime/job cards as the main narrative
- duplicate assistant replies
- repeated completion notifications on refresh/reconnect

### Composer contract

The composer is the primary command surface.

Required behavior:

- the input shell is the dominant affordance
- `Enter` sends and `Shift+Enter` inserts newline
- image attach/paste/drop is first-class
- model and permission controls stay visible but compact
- rare flags live in a secondary popover/panel
- slash commands and command-menu entry are visible parts of the interaction model

Forbidden behavior:

- large multi-row settings grids in the default composer state
- forcing the user to inspect flags before typing
- dead controls for unsupported capabilities

### Review contract

The workbench must support a dedicated review pane.

Required behavior:

- toggled from the workbench
- shows file-level navigation and inline review cards
- supports dismiss/stage/revert style actions
- does not dump review artifacts into the main conversation flow

### Terminal contract

The workbench must support a bottom terminal drawer.

Required behavior:

- terminal is project/worktree scoped
- toggled without leaving the thread
- visually secondary to the conversation, but immediately available
- shell output is not rendered as ordinary chat messages

## Visual Contract

Required:

- system/macOS-adjacent typography
- neutral palette, restrained accents, black CTA, soft separators
- rounded surfaces with low-noise shadows
- compact left rail and spacious but calm workbench
- animation limited to subtle state transitions and sheet/drawer movement

Forbidden:

- loud radial gradients as the app identity
- admin-console density in the main shell
- decorative chrome that competes with the workbench
- faux browser-window traffic lights inside page content

## Acceptance Gate

The first parity milestone passes only if all of the following are true:

1. The app opens directly into a workbench-first shell.
2. Projects and threads can be navigated without management-heavy UI.
3. Host is visible only as secondary context.
4. The composer feels like the primary workspace control, not a settings form.
5. Review appears as a real pane, not as text dumped into chat.
6. Terminal appears as a real drawer, not as a timeline artifact.
7. Background thread completion produces one unread/notification signal only once.
8. Refresh and reconnect do not duplicate assistant completions.
9. Visual regression snapshots match the intended native layout baseline.
10. Live staging flows pass without exposing transport/controller jargon.

## Delivery Order

1. Documentation baseline
2. Shell reduction and route cleanup
3. Sidebar / project-thread navigator redesign
4. Header and composer redesign
5. Review pane integration
6. Terminal drawer integration
7. Utility-surface isolation
8. Visual and live parity gates
