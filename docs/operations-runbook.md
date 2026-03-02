# Operational Runbook

This runbook is for on-call operation of `remote-llm-cli` controller deployments.

## 1. Basic health checks

1. Verify service health:
   - `GET /v1/healthz`
2. Verify control-plane metrics:
   - `GET /v1/metrics`
   - Check `queue.depth`, `queue.workers_active`, `success_rate`
3. Verify API auth:
   - Call `GET /v1/runtimes` with access key

## 2. Queue/backlog troubleshooting

Symptoms:
- Jobs stay `pending`
- `queue.depth` grows continuously

Checks:
1. Inspect metrics:
   - if `workers_active == workers_total`, workers are saturated
2. Inspect jobs:
   - `GET /v1/jobs?status=pending,running&limit=100`
3. Inspect failed/canceled trend:
   - `GET /v1/jobs?status=failed,canceled&limit=100`

Actions:
1. Reduce fanout/retry in client requests.
2. Cancel stale jobs: `POST /v1/jobs/{id}/cancel`.
3. Restart server process only after persisting state file and confirming no destructive operations in-flight.

## 3. SSH connectivity/auth failures

Symptoms:
- target errors with `error_class=auth|network|host_key`

Checks:
1. Probe host with preflight:
   - `POST /v1/hosts/{id}/probe` body `{"preflight": true}`
2. Check returned `error_class` + `error_hint`.
3. Verify host SSH options (`proxy_jump`, timeout, keepalive, host-key policy).

Actions by class:
1. `auth`:
   - verify `user`, `identity_file`, target `authorized_keys`
2. `network`:
   - verify host/port, route, security group, proxy jump chain
3. `host_key`:
   - update `known_hosts` or temporarily use `ssh_host_key_policy=accept-new`

## 4. Data growth / retention

Symptoms:
- state file grows too fast

Checks:
1. Read current retention:
   - `GET /v1/admin/retention`
2. Estimate write pressure from jobs/audit rates.

Actions:
1. Update retention policy:
   - `POST /v1/admin/retention`
2. Suggested baseline:
   - `run_records_max=1000`
   - `run_jobs_max=5000`
   - `audit_events_max=10000`

## 5. Audit/event investigation

1. Filter by action:
   - `GET /v1/audit?action=job.cancel&limit=200`
2. Filter by status:
   - `GET /v1/audit?status=502&limit=200`
3. Time slicing:
   - use `from`/`to` (`RFC3339` or unix seconds)

## 6. Incident closure checklist

1. Queue depth returns to normal.
2. Failure rate falls back to baseline.
3. Root cause and mitigation are captured in repo issue/PR notes.
4. Retention and alert thresholds are reviewed for recurrence prevention.
