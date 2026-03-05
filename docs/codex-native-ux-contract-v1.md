# Codex Native UX Contract v1

## Goal

Ship a native-grade Codex app experience in WebCLI with a strict session-first UI:

- left: `Server -> Project -> Session`
- right: active session conversation + composer
- no controller internals in session UX

This contract is the implementation baseline for Epic #137.

## In Scope

- Session interaction parity (send, stream, reconnect, resume, archive)
- Sidebar parity (project/session management and stable ordering)
- Composer parity (real model list, permissions, image send)
- Background completion sync and focused notifications

## Out of Scope

- Multi-runtime UX expansion beyond Codex in this wave
- Non-session ops console redesign
- Backend transport replacement (keep current API surface, harden behavior)

## Information Architecture

1. Sidebar hierarchy: `Server -> Project -> Session`
2. Project is the primary workspace unit under a server.
3. Session is the primary interaction unit under a project.
4. Right pane always shows exactly one active session.

Rules:

- No job/run/protocol status cards in the user timeline.
- Technical diagnostics remain in logs/devtools, not chat content.

## Session State Contract

Source of truth split:

- server truth: host/project/session existence, runtime status, event stream
- local cache: draft input, collapsed tree state, focus cursor, unread marker

Reconciliation rules:

1. Server sync may remove local entities that no longer exist remotely.
2. Local cache must never resurrect deleted/archived project/session records.
3. Active pointer fallback order:
   - same id if present
   - same host+path (project) or nearest sibling (session)
   - first available item

## Stream Contract

Event pipeline must guarantee:

1. Monotonic cursor progression per session.
2. Idempotent event apply (dedupe by event identity/cursor).
3. Ordered render for assistant output.
4. Reconnect replay starts from last persisted cursor.

Failure behavior:

- transient stream failure => retry with bounded backoff
- replayed historical events => do not trigger completion notifications

## Timeline Interaction Contract

1. Auto-scroll when pinned to bottom.
2. If user scrolls up, preserve position and show `Jump to latest`.
3. Enter sends; Shift+Enter inserts newline.
4. Composer clears immediately on submit when accepted.

## Background Sync and Notifications

1. Non-active sessions continue syncing in background.
2. Completion notification is once-per-new-completion outcome.
3. Refresh/replay must not emit old completion bursts.
4. Unread completion badge clears when user opens that session.

## Composer Contract

1. Model selector values come from target host runtime discovery.
2. Show default model and selectable alternatives.
3. Session-level permission/sandbox controls are visible but minimal.
4. Image attach/send is first-class and does not break text flow.

## Acceptance Gate

All must pass before parity claim:

1. No duplicate assistant replies across refresh/reconnect.
2. No stale project/session resurrection after archive/delete.
3. No timeline technical-noise messages in session mode.
4. Sidebar ordering/focus remains stable during background sync.
5. Playwright parity suite (mock + live) green in CI/staging.
6. Staging soak passes with no P0/P1 interaction regressions.

## Issue Mapping

- Epic: #137
- #138 session state contract: server truth + local cache boundaries
- #139 stream pipeline: dedupe/order/reconnect/cursor resume
- #140 timeline UX: content-only rendering + scroll pin behavior
- #141 sidebar IA: server/project/session operations parity
- #142 background sync: inactive session completion notifications
- #143 composer parity: model discovery + permission/image controls
- #144 session title lifecycle: derive/update/persist consistency
- #145 parity e2e suite: mock/live scenario matrix
- #146 release gate: staging soak checklist for native parity
