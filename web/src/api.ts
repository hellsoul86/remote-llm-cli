export type Host = {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  identity_file?: string;
  workspace?: string;
  tags?: string[];
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
  }>;
};

export type RunJobRecord = {
  id: string;
  type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  runtime: string;
  prompt_preview: string;
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

export async function listRunJobs(token: string, limit = 30): Promise<RunJobRecord[]> {
  const res = await fetch(`${API_BASE}/v1/jobs?limit=${encodeURIComponent(String(limit))}`, { headers: headers(token) });
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

export async function listAudit(token: string, limit = 100): Promise<AuditEvent[]> {
  const res = await fetch(`${API_BASE}/v1/audit?limit=${encodeURIComponent(String(limit))}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`list audit failed: ${res.status}`);
  const body = await res.json();
  return body.events ?? [];
}
