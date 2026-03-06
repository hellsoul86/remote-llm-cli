# Codex Native UX Contract v2

Scope reset date: 2026-03-07 (Asia/Shanghai)
Primary issue: #192
Supersedes: `docs/codex-native-ux-contract-v1.md` as the acceptance source for new Codex web UX work.

## Goal

Ship a Codex web experience that feels structurally and behaviorally close to the native Codex macOS app.

This is no longer accepted by feature coverage alone. The acceptance standard is:

- focus: one active session workbench at a time
- navigation: compact project/session navigation on the left
- control density: minimal by default, contextual when needed
- background work: visible but quiet
- user language: no transport/controller jargon in the happy path

## Product Positioning

Codex should feel like a command center for active sessions, not an operations dashboard.

Implications:

1. The app shell exists to help the user move between projects and sessions quickly.
2. The active session pane must stay visually dominant.
3. Operational/platform tools are secondary surfaces, not peers of the chat workspace.
4. Native parity is judged by flow quality and interaction calmness, not by how many raw toggles are visible.

## Current Gap Audit

The current web experience is still materially off-target in these ways:

1. Top-level chrome is too controller-oriented.
   - `Session/Ops` mode switching makes the product feel like two apps in one shell.
   - global sync/health/logout controls dominate the first visual layer.
2. The left rail behaves like CRUD management, not navigation.
   - inline project forms, rename buttons, archive buttons, host collapse controls, and explanatory copy make the rail heavy.
   - the native target should bias toward compact navigation with contextual actions.
3. The session header exposes transport mechanics.
   - stream pills, reconnect buttons, and archive buttons are too prominent for the main conversation workbench.
4. The composer behaves like a settings form.
   - model, sandbox, fork, advanced, approval, config flags, and add-dir controls are too expanded by default.
   - the input area should remain the primary affordance.
5. Utility surfaces bleed into the session experience.
   - auth, MCP, cloud, and ops concepts still shape the main shell too much.
6. Notifications still risk feeling mechanical.
   - background completions should surface as subtle sidebar state + optional OS notification, not as repeated ambient chatter.
7. Acceptance criteria are still biased toward capability matrices.
   - matching CLI flags is useful, but it is not the main UX success metric.

## Interaction Model

### 1. Shell

- The default shell is always session-first.
- Left side: `Server -> Project -> Session` navigation rail.
- Right side: one active session workbench.
- No primary `Ops` mode toggle in the top chrome.
- Global chrome must be visually quiet and utility-grade.

### 2. Sidebar

The sidebar is a navigation rail, not a control panel.

Rules:

- Prioritize active project/session navigation, unread state, and running state.
- Keep host metadata visually compressed.
- Project and session creation should use lightweight sheets, menus, or command palette actions.
- Rename/archive actions must move into contextual menus or secondary affordances.
- Empty-state copy should be short and non-instructional.

### 3. Active Session Workbench

The active workbench contains only:

- session title and minimal context
- conversation timeline
- inline approval/pending request surfaces
- composer

Rules:

- No controller health language in the happy path.
- No job/run/protocol cards in the primary timeline.
- No persistent reconnect/archive controls in the primary header.
- Technical recovery controls belong in overflow/debug surfaces.

### 4. Timeline

The timeline is content-first.

Rules:

- User and assistant content should dominate visually.
- Status transitions must be lightweight and non-repetitive.
- Approval requests appear inline where action is needed.
- Auto-scroll, jump-to-latest, and refresh replay must feel invisible when working normally.
- Background replay must never duplicate visible completions or produce stale completion noise.

### 5. Composer

The composer is the primary command surface.

Rules:

- Text input is the visual anchor.
- `Enter` sends and `Shift+Enter` inserts newline.
- Model, permission/sandbox, and image attach remain first-class, but render as compact contextual controls rather than a settings grid.
- Rare flags (`profile`, `config`, `enable`, `disable`, `add-dir`, `json`, `ephemeral`, `skip-git-repo-check`) belong behind a secondary surface.
- Fork/review/resume style actions should be contextual, not always-on primary buttons.

### 6. Background Sessions

Background activity must stay reliable without stealing focus.

Rules:

- Non-active sessions continue syncing.
- Running state is visible in the sidebar.
- Completion creates one unread/background signal only once per new outcome.
- Opening the session clears unread state.
- Refresh/reconnect must not replay old notifications.

### 7. Utility Surfaces

These remain important, but must not shape the main session shell:

- auth and account state
- host/platform operations
- MCP management
- cloud/task utilities
- raw diagnostics

They should live in settings, drawers, popovers, or dedicated secondary surfaces.

## Acceptance Gate

Native-parity work is accepted only if the following flows feel close to the macOS app baseline:

1. Open the app and immediately understand where to continue work.
2. Move between projects and sessions without passing through management-heavy UI.
3. Start a prompt with minimal chrome in the way.
4. Switch model/permission/image context without leaving the session workbench.
5. Leave one session running, switch to another, and come back without losing state.
6. Refresh during or after a stream and see no duplicate assistant completions.
7. Resolve approvals inline without transport jargon.
8. Notice background completions without toast spam.
9. Archive or manage a session/project from contextual controls, not header clutter.
10. Never need to understand `job`, `run`, `cursor`, `stream`, or controller health concepts to complete ordinary work.

## Delivery Order

1. Shell reduction
   - remove controller-first chrome from the primary experience
   - demote ops/platform surfaces out of the main session shell
2. Sidebar redesign
   - compact navigation, contextual actions, clearer running/unread states
3. Session workbench cleanup
   - simplify header and timeline chrome
   - remove transport-centric emphasis
4. Composer redesign
   - compress model/permission/image controls into native-style affordances
   - push rare flags behind secondary surfaces
5. Validation
   - mock parity e2e
   - live staging parity e2e
   - soak signoff against this contract

## Issue Mapping

- Epic: #137
- Reset/design contract: #192
- Mock/live parity evidence: #145
- Soak/release gate: #146
- Architecture cutover completion: #168, #172
