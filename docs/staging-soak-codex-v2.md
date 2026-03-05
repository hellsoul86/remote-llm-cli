# Staging Soak: Codex v2 Session Stream

Use this runbook to execute the #171/#172 staging soak gate with reconnect interruptions and cursor continuity metrics.

## 1. Preconditions

- API and web are deployed from latest `staging`.
- Access key can call `/v2/codex/sessions/*`.
- Target host id is available in controller host list.

Required values:

- `REMOTE_LLM_API` (example: `https://webcli-api-staging.royding.ai`)
- `REMOTE_LLM_KEY` (staging access key)
- `REMOTE_LLM_HOST_ID` (example: `local-default`)
- `REMOTE_LLM_PROJECT_PATH` (workspace path on target host)

## 2. Run Soak Probe

Run from repo root:

```bash
cd server
go run ./cmd/remote-llm-soak \
  -api "$REMOTE_LLM_API" \
  -token "$REMOTE_LLM_KEY" \
  -host-id "$REMOTE_LLM_HOST_ID" \
  -path "$REMOTE_LLM_PROJECT_PATH" \
  -duration 24h \
  -reconnect-window 30s \
  -prompt-interval 2m \
  -out /tmp/codex-v2-soak-staging.json
```

Optional:

- Add `-archive-on-exit` to archive the probe session when soak exits.
- Set `-model` to lock a specific staging model.

## 3. Report Interpretation

The generated JSON includes:

- `stream.last_seq`: latest processed session cursor.
- `stream.duplicate_seq`: duplicate replay count.
- `stream.non_monotonic_seq`: out-of-order count.
- `stream.missing_seq`: cursor gap count.
- `stream.ready_frames`, `stream.reset_frames`: reconnect behavior.
- `turns.succeeded/failed`: synthetic prompt success ratio.

## 4. Soak Gate (Pass Criteria)

- `stream.non_monotonic_seq == 0`
- `stream.missing_seq == 0`
- No sustained growth in `stream.duplicate_seq`
- No stuck stream (cursor keeps advancing while turns succeed)
- No P0/P1 UX regressions in web smoke checks

## 5. Evidence for Issues/Release PR

Attach in #171 / #172 / release PR:

1. Command line used (with timestamps and staging commit SHA).
2. `/tmp/codex-v2-soak-staging.json` summary.
3. CI links:
   - `cd server && go test ./...`
   - `cd web && npm run build`
   - `cd web && npm run test:e2e:smoke`
