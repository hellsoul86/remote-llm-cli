export type Host = {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  identity_file?: string;
  workspace?: string;
  tags?: string[];
  ssh_proxy_jump?: string;
  ssh_connect_timeout_sec?: number;
  ssh_server_alive_interval_sec?: number;
  ssh_server_alive_count_max?: number;
  ssh_host_key_policy?: "accept-new" | "strict" | "insecure-ignore";
};

export type RuntimeInfo = {
  name: string;
  capabilities: {
    supports_non_interactive_exec: boolean;
    supports_interactive_session: boolean;
    supports_structured_output: boolean;
    supports_file_patch_mode: boolean;
    supports_cost_metrics: boolean;
  };
  contract?: {
    version: string;
    prompt_required: boolean;
    supports_workdir: boolean;
    supports_extra_args: boolean;
  };
};

export type RunRequest = {
  runtime: string;
  prompt: string;
  host_id?: string;
  host_ids?: string[];
  all_hosts?: boolean;
  fanout?: number;
  workdir?: string;
  extra_args?: string[];
  timeout_sec?: number;
  max_output_kb?: number;
  retry_count?: number;
  retry_backoff_ms?: number;
  codex?: {
    mode?: "exec" | "resume" | "review";
    session_id?: string;
    resume_last?: boolean;
    model?: string;
    profile?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    config?: string[];
    enable?: string[];
    disable?: string[];
    add_dirs?: string[];
    images?: string[];
    local_provider?: string;
    color?: "always" | "never" | "auto";
    oss?: boolean;
    full_auto?: boolean;
    progress_cursor?: boolean;
    skip_git_repo_check?: boolean;
    ephemeral?: boolean;
    json_output?: boolean;
    review_uncommitted?: boolean;
    dangerously_bypass_approvals_and_sandbox?: boolean;
    output_last_message_file?: string;
    review_base?: string;
    review_commit?: string;
    review_title?: string;
  };
};

export type RunTargetResult = {
  host: Host;
  result: {
    command?: string;
    stdout?: string;
    stderr?: string;
    stdout_bytes?: number;
    stderr_bytes?: number;
    stdout_truncated?: boolean;
    stderr_truncated?: boolean;
    exit_code?: number;
    duration_ms?: number;
    started_at?: string;
    finished_at?: string;
  };
  ok: boolean;
  error?: string | null;
  error_class?: string;
  error_hint?: string;
  attempts?: number;
  codex?: {
    jsonl: boolean;
    event_count: number;
    invalid_lines?: number;
    last_event_type?: string;
    parse_error?: string;
  };
};

export type RunResponse = {
  runtime: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    fanout: number;
    retry_count?: number;
    retry_backoff_ms?: number;
    duration_ms: number;
    started_at: string;
    finished_at: string;
  };
  targets: RunTargetResult[];
};

export type SyncRequest = {
  host_id?: string;
  host_ids?: string[];
  all_hosts?: boolean;
  fanout?: number;
  timeout_sec?: number;
  max_output_kb?: number;
  retry_count?: number;
  retry_backoff_ms?: number;
  src: string;
  dst: string;
  delete?: boolean;
  excludes?: string[];
};

export type SyncResponse = {
  operation: "sync";
  runtime?: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    fanout: number;
    retry_count?: number;
    retry_backoff_ms?: number;
    duration_ms: number;
    started_at: string;
    finished_at: string;
  };
  targets: RunTargetResult[];
};

export type RunRecord = {
  id: string;
  runtime: string;
  prompt_preview: string;
  total_hosts: number;
  succeeded_hosts: number;
  failed_hosts: number;
  fanout: number;
  status_code: number;
  duration_ms: number;
  created_by_key_id?: string;
  started_at: string;
  finished_at: string;
  targets: Array<{
    host_id: string;
    host_name: string;
    ok: boolean;
    exit_code: number;
    duration_ms: number;
    error?: string;
    error_class?: string;
  }>;
};

export type RunJobRecord = {
  id: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  runtime: string;
  prompt_preview: string;
  host_ids?: string[];
  created_by_key_id?: string;
  queued_at: string;
  started_at?: string;
  finished_at?: string;
  result_status?: number;
  total_hosts?: number;
  succeeded_hosts?: number;
  failed_hosts?: number;
  fanout?: number;
  duration_ms?: number;
  error?: string;
  request?: RunRequest | SyncRequest;
  response?: RunResponse | SyncResponse;
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  remote_addr?: string;
  created_by_key_id?: string;
  action: string;
};

export type RetentionPolicy = {
  run_records_max: number;
  run_jobs_max: number;
  audit_events_max: number;
};

export type MetricsResponse = {
  jobs: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    canceled: number;
    retry_attempts: number;
  };
  queue: {
    depth: number;
    workers_total: number;
    workers_active: number;
    worker_utilization: number;
  };
  success_rate: number;
};

export type CodexSessionInfo = {
  session_id: string;
  path: string;
  updated_at: string;
  size_bytes: number;
};

export type CodexSessionTarget = {
  host: Host;
  ok: boolean;
  error?: string;
  sessions?: CodexSessionInfo[];
};

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080";

function headers(token?: string): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export async function healthz(): Promise<{ ok: boolean; timestamp: string }> {
  const res = await fetch(`${API_BASE}/v1/healthz`);
  if (!res.ok) throw new Error(`healthz failed: ${res.status}`);
  return res.json();
}

export async function listHosts(token: string): Promise<Host[]> {
  const res = await fetch(`${API_BASE}/v1/hosts`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list hosts failed: ${res.status}`);
  const body = await res.json();
  return body.hosts ?? [];
}

export async function listRuntimes(token: string): Promise<RuntimeInfo[]> {
  const res = await fetch(`${API_BASE}/v1/runtimes`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list runtimes failed: ${res.status}`);
  const body = await res.json();
  return body.runtimes ?? [];
}

export async function upsertHost(token: string, host: Partial<Host>): Promise<Host> {
  const res = await fetch(`${API_BASE}/v1/hosts`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(host)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upsert host failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  return body.host;
}

export async function runFanout(token: string, request: RunRequest): Promise<{ status: number; body: RunResponse }> {
  const res = await fetch(`${API_BASE}/v1/run`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(request)
  });
  const body = await res.json();
  if (!res.ok && !body?.summary) {
    throw new Error(`run failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

export async function enqueueRunJob(token: string, request: RunRequest): Promise<{ status: number; body: { job: RunJobRecord } }> {
  const res = await fetch(`${API_BASE}/v1/jobs/run`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(request)
  });
  const body = await res.json();
  if (!res.ok || !body?.job) {
    throw new Error(`enqueue run job failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

export async function enqueueSyncJob(token: string, request: SyncRequest): Promise<{ status: number; body: { job: RunJobRecord } }> {
  const res = await fetch(`${API_BASE}/v1/jobs/sync`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(request)
  });
  const body = await res.json();
  if (!res.ok || !body?.job) {
    throw new Error(`enqueue sync job failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

type JobListFilters = {
  status?: string[];
  type?: string[];
  runtime?: string[];
  host_id?: string;
  from?: string;
  to?: string;
};

export async function listRunJobs(token: string, limit = 30, filters?: JobListFilters): Promise<RunJobRecord[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters?.status && filters.status.length > 0) params.set("status", filters.status.join(","));
  if (filters?.type && filters.type.length > 0) params.set("type", filters.type.join(","));
  if (filters?.runtime && filters.runtime.length > 0) params.set("runtime", filters.runtime.join(","));
  if (filters?.host_id) params.set("host_id", filters.host_id);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const res = await fetch(`${API_BASE}/v1/jobs?${params.toString()}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list jobs failed: ${res.status}`);
  const body = await res.json();
  return body.jobs ?? [];
}

export async function getRunJob(token: string, id: string): Promise<RunJobRecord> {
  const res = await fetch(`${API_BASE}/v1/jobs/${encodeURIComponent(id)}`, { headers: headers(token) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`get job failed: ${res.status} ${text}`);
  }
  const body = await res.json();
  if (!body?.job) throw new Error("get job failed: invalid response");
  return body.job;
}

export async function cancelRunJob(token: string, id: string): Promise<{ state: string; job: RunJobRecord }> {
  const res = await fetch(`${API_BASE}/v1/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: headers(token)
  });
  const body = await res.json();
  if (!res.ok || !body?.job) {
    throw new Error(`cancel job failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

export async function discoverCodexSessions(
  token: string,
  request: { host_id?: string; host_ids?: string[]; all_hosts?: boolean; fanout?: number; timeout_sec?: number; limit_per_host?: number }
): Promise<{ status: number; body: { targets: CodexSessionTarget[] } }> {
  const res = await fetch(`${API_BASE}/v1/codex/sessions/discover`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(request)
  });
  const body = await res.json();
  if (!res.ok && !body?.targets) {
    throw new Error(`discover codex sessions failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

export async function syncHosts(token: string, request: SyncRequest): Promise<{ status: number; body: SyncResponse }> {
  const res = await fetch(`${API_BASE}/v1/sync`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(request)
  });
  const body = await res.json();
  if (!res.ok && !body?.summary) {
    throw new Error(`sync failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

export async function listRuns(token: string, limit = 20): Promise<RunRecord[]> {
  const res = await fetch(`${API_BASE}/v1/runs?limit=${encodeURIComponent(String(limit))}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
  const body = await res.json();
  return body.runs ?? [];
}

type AuditListFilters = {
  status?: number;
  action?: string;
  method?: string;
  path_prefix?: string;
  from?: string;
  to?: string;
};

export async function listAudit(token: string, limit = 100, filters?: AuditListFilters): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters?.status) params.set("status", String(filters.status));
  if (filters?.action) params.set("action", filters.action);
  if (filters?.method) params.set("method", filters.method);
  if (filters?.path_prefix) params.set("path_prefix", filters.path_prefix);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  const res = await fetch(`${API_BASE}/v1/audit?${params.toString()}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list audit failed: ${res.status}`);
  const body = await res.json();
  return body.events ?? [];
}

export async function getMetrics(token: string): Promise<MetricsResponse> {
  const res = await fetch(`${API_BASE}/v1/metrics`, { headers: headers(token) });
  if (!res.ok) throw new Error(`metrics failed: ${res.status}`);
  return res.json();
}

export async function getRetentionPolicy(token: string): Promise<RetentionPolicy> {
  const res = await fetch(`${API_BASE}/v1/admin/retention`, { headers: headers(token) });
  if (!res.ok) throw new Error(`get retention failed: ${res.status}`);
  const body = await res.json();
  return body.retention;
}

export async function setRetentionPolicy(token: string, retention: RetentionPolicy): Promise<RetentionPolicy> {
  const res = await fetch(`${API_BASE}/v1/admin/retention`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(retention)
  });
  const body = await res.json();
  if (!res.ok || !body?.retention) throw new Error(`set retention failed: ${res.status} ${JSON.stringify(body)}`);
  return body.retention;
}
