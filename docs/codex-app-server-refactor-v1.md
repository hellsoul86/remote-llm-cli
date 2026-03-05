# Codex App-Server Refactor (v1)

## Goal

Upgrade Codex session transport from the current `job + target.stdout + mapped session events` model to the official `codex app-server` JSON-RPC protocol while preserving:

- multi-host control plane,
- access-key auth and audit model,
- `Server -> Project -> Session` UX contract.

This is a **Codex-specific transport upgrade**, not a full runtime-platform rewrite. Non-Codex runtimes remain on current job/scheduler paths.

## Why this change

Current implementation for Codex chat is built on top of `codex exec` job execution and event mapping. It works, but has structural UX risks:

- duplicate/replayed lifecycle messages,
- delayed or missing assistant deltas,
- implicit fallback to job response payload when stream is incomplete,
- custom event schema drift vs actual Codex protocol.

`codex app-server` already exposes thread/turn/item lifecycle, approvals, archive/unarchive, model list, and structured streaming semantics. Using it directly removes most translation debt.

## Non-goals

- Replace sync jobs, fanout jobs, or non-Codex adapters.
- Remove existing `/v1/jobs/*` control APIs.
- Move to direct browser->remote-host connections.
- Depend on app-server websocket transport in production.

## Hard decisions

1. Host transport is `SSH + stdio` only for production.
2. Browser transport is `WebSocket` primary, `SSE` fallback/replay.
3. Codex chat path becomes thread/turn-native; job IDs are no longer the primary session primitive.
4. Existing job path is retained behind compatibility mode and for non-Codex runtimes.

## Target architecture

```text
Web UI
  -> WS/SSE (/v2/codex/sessions/*)
API Server (Go)
  - Auth/Audit/Project/Session store
  - Codex Bridge Manager
  - Event Log + Cursor persistence
  -> SSH (per host) -> codex app-server --listen stdio://
Remote Host
  - codex app-server process
  - codex local state (~/.codex)
```

### Component split

1. `api` layer
- validates token + host/project/session binding
- exposes REST/WS endpoints for session lifecycle and stream

2. `codexrpc` bridge layer (new)
- maintains per-host app-server client over SSH stdio
- handles JSON-RPC request/response correlation
- forwards notifications to event store + live subscribers
- handles server-initiated approval requests

3. `session-store` layer (extended existing store)
- stores codex session/thread bindings
- stores monotonic event log with cursor
- stores pending server requests (approval/request_user_input)

4. `web` transport client
- consumes official notification methods
- renders timeline from thread/turn/item notifications
- resolves approvals with dedicated actions

## Protocol and state model

### Session identity model

- `host_id` + `project_id` stay controller-defined.
- `session_id` maps 1:1 to Codex `thread.id` for Codex runtime.
- `runtime_session_id` legacy field becomes optional compatibility field.

### Source of truth

1. Codex thread state: app-server.
2. Controller linkage and cursor: local store.
3. UI drafts/collapse/unread: local browser state.

### Event persistence format (new)

Persist raw, typed protocol notifications instead of synthetic status lines:

- `seq` (controller monotonic per session)
- `session_id`
- `thread_id`
- `turn_id` (optional)
- `method` (JSON-RPC notification method, e.g. `item/agentMessage/delta`)
- `params` (raw JSON)
- `created_at`
- `origin` (`replay` | `live`)

### Ordering and dedupe

1. Apply events in persisted `seq` order only.
2. Dedupe by protocol identity (`method + params item keys`) within a bounded window.
3. Reconnect replay starts from last persisted cursor.
4. Replayed historical events never trigger completion toasts.

## API surface (v2)

### Session lifecycle

- `POST /v2/codex/sessions/start`
- `POST /v2/codex/sessions/{id}/resume`
- `POST /v2/codex/sessions/{id}/fork`
- `POST /v2/codex/sessions/{id}/archive`
- `POST /v2/codex/sessions/{id}/unarchive`
- `POST /v2/codex/sessions/{id}/name`

### Turns

- `POST /v2/codex/sessions/{id}/turns/start`
- `POST /v2/codex/sessions/{id}/turns/{turn_id}/interrupt`
- `POST /v2/codex/sessions/{id}/turns/{turn_id}/steer`

### Stream

- `GET /v2/codex/sessions/{id}/events?after=`
- `GET /v2/codex/sessions/{id}/stream` (SSE replay/live)
- `GET /v2/codex/sessions/{id}/ws` (live push + replay cursor handshake)

### Approvals and server requests

- `GET /v2/codex/sessions/{id}/requests/pending`
- `POST /v2/codex/sessions/{id}/requests/{request_id}/resolve`

### Catalog

- `GET /v2/codex/models?host_id=...` (backed by `model/list` via bridge)

## Compatibility and rollout switches

Feature flags:

- `CODEX_TRANSPORT_MODE=legacy|hybrid|appserver`
- `CODEX_WS_ENABLED=true|false`
- `CODEX_APP_SERVER_IDLE_TTL_SEC`

Behavior:

- `legacy`: current job-based Codex flow.
- `hybrid`: new v2 endpoints + legacy fallback for selected actions.
- `appserver`: Codex chat fully on bridge path.

Rollback is one env toggle + deploy.

## UX impact

Expected gains:

- true turn/item streaming (no fake `Done` fallback),
- no job lifecycle noise in timeline,
- native approval prompts with correct decision semantics,
- stable session continuity across refresh/reconnect,
- model list from actual host app-server state.

## Security and operations

1. No direct browser access to host; all host access remains via controller auth.
2. SSH command is fixed (`codex app-server --listen stdio://`), no user-injected command path.
3. Pending approvals are session-scoped and ACL-checked by token.
4. Audit adds:
- bridge connect/disconnect,
- protocol request method/status,
- approval decisions.

## Observability additions

New metrics:

- `codex_bridge_connected_hosts`
- `codex_bridge_reconnect_total`
- `codex_bridge_notification_lag_ms`
- `codex_pending_requests`
- `codex_session_ws_subscribers`
- `codex_stream_replay_events_total`

New structured logs:

- bridge lifecycle (`host_id`, `reason`),
- RPC request/response timings (`method`, `duration_ms`),
- notification ingest/backpressure.

## Testing strategy

1. Unit:
- JSON-RPC framing and correlation
- event dedupe/order logic
- cursor replay math

2. Contract:
- pinned generated protocol types (from `codex app-server generate-ts`)
- method payload compatibility tests

3. Integration:
- SSH stdio bridge against staging host codex
- reconnect and interruption behavior

4. E2E (Playwright):
- stream continuity across refresh
- no duplicate assistant output
- approval request/resolve flow
- archive/unarchive lifecycle

## Migration phases

### Phase A: Foundation

- add `codexrpc` bridge package
- add protocol-generated TS types in web
- add feature flags and compatibility gate

### Phase B: Backend v2 transport

- implement host bridge manager + event persistence
- implement v2 session/turn/approval endpoints
- add ws + sse replay endpoints

### Phase C: Web transport migration

- move session chat from job model to thread/turn model
- render official notifications directly
- approval UI and pending-request recovery

### Phase D: Hardening and cutover

- dual-path soak (`hybrid`)
- staging replay/latency validation
- production switch to `appserver`
- keep legacy job path only for non-codex runtimes

## Risks and mitigations

1. Long-lived SSH bridge instability
- mitigation: per-host reconnect loop + idle TTL + health probes

2. Protocol drift across codex versions
- mitigation: generated schema pinned per deployed codex version + CI contract tests

3. Event flood/backpressure
- mitigation: bounded channel + overload counters + replay-safe reconnect

4. Approval request loss on reconnect
- mitigation: server-persisted pending request store + startup replay

## Definition of done

1. Active session response streaming is token-level and uninterrupted under refresh.
2. No user-visible `job.*`/`target.*` messages in session timeline.
3. No duplicate assistant final responses in parity e2e and live staging tests.
4. Archive/unarchive/name/fork/resume are driven by official thread APIs.
5. Rollback from `appserver` to `legacy` requires config-only change.
