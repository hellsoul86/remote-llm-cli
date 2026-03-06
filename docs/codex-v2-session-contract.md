# Codex v2 Session Contract

This document defines the **session-mode API contract** used by WebCLI for Codex interactions.

Scope date: 2026-03-06 (Asia/Shanghai).
Version: `v1` (contract freeze wave for issues #169/#170/#171).

## Contract Rules

- Session UI must use `/v2/codex/sessions/*` APIs only for chat/session interaction.
- Session stream transport is `WebSocket first`, `SSE fallback`.
- Cursor progression is monotonic per session and replay-safe.
- Event application in clients must be idempotent by `seq`.
- Legacy `/v1/jobs/*` is out of session-mode scope.
- Pinned upstream protocol artifacts live under `schema/codex-app-server-protocol/`.
- Regenerate pinned artifacts with `make protocol-schema-sync`.
- Validate pinned artifacts against the surface we use with `make protocol-schema-validate`.

## Authentication

- HTTP APIs: `Authorization: Bearer <access_key>`.
- WS stream API: `Authorization` bearer is preferred; `access_token` query parameter is supported for browser WS compatibility.

## Endpoints

### Session Lifecycle

- `POST /v2/codex/sessions/start`
- `POST /v2/codex/sessions/{id}/resume`
- `POST /v2/codex/sessions/{id}/fork`
- `POST /v2/codex/sessions/{id}/archive`
- `POST /v2/codex/sessions/{id}/unarchive`
- `POST /v2/codex/sessions/{id}/name`

### Turn Lifecycle

- `POST /v2/codex/sessions/{id}/turns/start`
- `POST /v2/codex/sessions/{id}/turns/{turn_id}/interrupt`
- `POST /v2/codex/sessions/{id}/turns/{turn_id}/steer`

### Server Request Approval

- `GET /v2/codex/sessions/{id}/requests/pending`
- `POST /v2/codex/sessions/{id}/requests/{request_id}/resolve`

### Session Event Stream

- `GET /v2/codex/sessions/{id}/events?after=<seq>&limit=<n>`
- `GET /v2/codex/sessions/{id}/stream?after=<seq>` (SSE)
- `GET /v2/codex/sessions/{id}/ws?after=<seq>[&access_token=...]` (WS)

## Canonical Event Types (Session Stream)

Primary normalized event types:

- `session.title.updated`
- `run.started`
- `run.completed`
- `run.failed`
- `run.canceled`
- `assistant.delta`

Compatibility passthrough:

- Unknown or non-normalized methods are emitted as `codexrpc.<method_with_dots>`.

## Session Event Record Shape

`session.event` payload is always a `SessionEvent` object:

```json
{
  "seq": 12,
  "session_id": "session_cli_1",
  "run_id": "turn_123",
  "type": "assistant.delta",
  "payload": {
    "chunk": "{\"type\":\"item.updated\", ...}\n"
  },
  "created_at": "2026-03-06T00:00:00Z"
}
```

## SSE Frame Contract

- Replay frames: `event: session.event` with `id: <seq>`.
- Stream readiness frame: `event: session.ready` with `cursor`.
- Heartbeat frame: `event: heartbeat` with `cursor`.
- Reset frame: `event: session.reset` with `reason=backpressure` and `next_after`.

## WS Frame Contract

Text JSON frames:

- `{"type":"session.event","id":"<seq>","event":{...SessionEvent...}}`
- `{"type":"session.ready","session_id":"...","cursor":<seq>}`
- `{"type":"heartbeat","session_id":"...","cursor":<seq>,"timestamp":"..."}`
- `{"type":"session.reset","session_id":"...","reason":"backpressure","next_after":<seq>}`

## Turn Start Request Fields

Supported fields include:

- Core: `host_id`, `prompt`, `input`, `model`, `cwd`, `approval_policy`, `sandbox`
- Mode: `mode` (`exec|resume|review`)
- Resume/review: `resume_last`, `resume_session_id`, `review_uncommitted`, `review_base`, `review_commit`, `review_title`
- Runtime flags: `search`, `profile`, `config[]`, `enable[]`, `disable[]`, `add_dirs[]`
- Safety/format: `skip_git_repo_check`, `ephemeral`, `json_output`
- Metadata: `metadata`

Example:

```json
{
  "host_id": "host_local",
  "prompt": "Summarize the latest test failures and propose fixes",
  "mode": "exec",
  "model": "gpt-5-codex",
  "cwd": "/home/ecs-user/repos/remote-llm-cli",
  "approval_policy": "onRequest",
  "sandbox": "workspaceWrite",
  "search": true,
  "skip_git_repo_check": true
}
```

## Pending Request Lifecycle

- Pending requests are stored per session and exposed via `GET .../requests/pending`.
- `serverRequest/resolved` removes pending entry by request id.
- Terminal turn events (`completed|failed|canceled|interrupted`) clear pending entries for that session.
- Pending entries are TTL-pruned (`45m`).

Resolve request example:

```json
{
  "decision": {
    "type": "approve"
  }
}
```

## Reliability Guarantees

- Deduplication: identical codex notifications are deduped before persistence.
- Reconnect: clients may reconnect with `after` cursor; server replays `seq > after`.
- Exactly-once rendering: client should dedupe using `seq` and persisted cursor.

## Deprecation Notes

- Session-mode interaction must not depend on `/v1/jobs/*`.
- `/v1/jobs/*` remains available for non-session operational workflows only.
- Contract freeze date: 2026-03-06.
- v1 job endpoints are legacy for session UX and are excluded from parity acceptance.
