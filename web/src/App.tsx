import { FormEvent, useEffect, useState } from "react";
import {
  cancelRunJob,
  discoverCodexSessions,
  enqueueRunJob,
  enqueueSyncJob,
  getMetrics,
  getRetentionPolicy,
  getRunJob,
  healthz,
  listAudit,
  listHosts,
  listRunJobs,
  listRuns,
  setRetentionPolicy,
  listRuntimes,
  runFanout,
  syncHosts,
  upsertHost,
  type AuditEvent,
  type Host,
  type MetricsResponse,
  type RetentionPolicy,
  type RunJobRecord,
  type RunRecord,
  type RunResponse,
  type RuntimeInfo,
  type SyncResponse
} from "./api";

const TOKEN_KEY = "remote_llm_access_key";

export function App() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [health, setHealth] = useState<string>("checking");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [runPrompt, setRunPrompt] = useState("summarize current repo state and risks");
  const [runWorkdir, setRunWorkdir] = useState("");
  const [runFanoutValue, setRunFanoutValue] = useState("3");
  const [runMaxOutputKB, setRunMaxOutputKB] = useState("256");
  const [runAllHosts, setRunAllHosts] = useState(true);
  const [runMode, setRunMode] = useState<"exec" | "resume" | "review">("exec");
  const [runModel, setRunModel] = useState("");
  const [runSandbox, setRunSandbox] = useState<"" | "read-only" | "workspace-write" | "danger-full-access">("");
  const [runJSONOutput, setRunJSONOutput] = useState(true);
  const [runSkipGitRepoCheck, setRunSkipGitRepoCheck] = useState(false);
  const [runEphemeral, setRunEphemeral] = useState(false);
  const [runResumeLast, setRunResumeLast] = useState(true);
  const [runSessionID, setRunSessionID] = useState("");
  const [runRetryCountValue, setRunRetryCountValue] = useState("0");
  const [runRetryBackoffMSValue, setRunRetryBackoffMSValue] = useState("1000");
  const [selectedHostIDs, setSelectedHostIDs] = useState<string[]>([]);
  const [runAsyncMode, setRunAsyncMode] = useState(true);
  const [runStatus, setRunStatus] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<RunResponse | null>(null);
  const [runJobs, setRunJobs] = useState<RunJobRecord[]>([]);
  const [jobStatusFilter, setJobStatusFilter] = useState("pending,running,failed,canceled,succeeded");
  const [jobRuntimeFilter, setJobRuntimeFilter] = useState("");
  const [jobHostFilter, setJobHostFilter] = useState("");
  const [activeRunJobID, setActiveRunJobID] = useState("");
  const [activeRunJob, setActiveRunJob] = useState<RunJobRecord | null>(null);
  const [runJobPolling, setRunJobPolling] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncAsyncMode, setSyncAsyncMode] = useState(true);
  const [syncAllHosts, setSyncAllHosts] = useState(true);
  const [syncSelectedHostIDs, setSyncSelectedHostIDs] = useState<string[]>([]);
  const [syncSrc, setSyncSrc] = useState("./");
  const [syncDst, setSyncDst] = useState("workspace");
  const [syncDelete, setSyncDelete] = useState(false);
  const [syncExcludes, setSyncExcludes] = useState(".git,node_modules");
  const [syncFanoutValue, setSyncFanoutValue] = useState("3");
  const [syncMaxOutputKB, setSyncMaxOutputKB] = useState("256");
  const [syncRetryCountValue, setSyncRetryCountValue] = useState("0");
  const [syncRetryBackoffMSValue, setSyncRetryBackoffMSValue] = useState("1000");
  const [syncStatus, setSyncStatus] = useState<number | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditStatusFilter, setAuditStatusFilter] = useState("");
  const [auditActionFilter, setAuditActionFilter] = useState("");
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [retRunRecordsMax, setRetRunRecordsMax] = useState("500");
  const [retRunJobsMax, setRetRunJobsMax] = useState("1000");
  const [retAuditEventsMax, setRetAuditEventsMax] = useState("5000");

  useEffect(() => {
    healthz()
      .then((h) => setHealth(`ok (${h.timestamp})`))
      .catch((e) => setHealth(`error: ${String(e)}`));
  }, []);

  function isRunJobActive(job: RunJobRecord | null | undefined): boolean {
    if (!job) return false;
    return job.status === "pending" || job.status === "running";
  }

  function isRunJobCancelable(job: RunJobRecord | null | undefined): boolean {
    return isRunJobActive(job);
  }

  function isRunResponsePayload(v: unknown): v is RunResponse {
    if (!v || typeof v !== "object") return false;
    return "runtime" in v && "summary" in v && "targets" in v && !("operation" in v);
  }

  function parseCSV(value: string): string[] {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  async function refresh() {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const [nextHosts, nextRuntimes, nextRuns, nextAudit, nextJobs, nextMetrics, nextRetention] = await Promise.all([
        listHosts(token),
        listRuntimes(token),
        listRuns(token, 20),
        listAudit(token, 80, {
          status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
          action: auditActionFilter.trim() || undefined
        }),
        listRunJobs(token, 30, {
          status: parseCSV(jobStatusFilter),
          runtime: parseCSV(jobRuntimeFilter),
          host_id: jobHostFilter.trim() || undefined
        }),
        getMetrics(token),
        getRetentionPolicy(token)
      ]);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setRunHistory(nextRuns);
      setAuditEvents(nextAudit);
      setRunJobs(nextJobs);
      setMetrics(nextMetrics);
      setRetention(nextRetention);
      setRetRunRecordsMax(String(nextRetention.run_records_max));
      setRetRunJobsMax(String(nextRetention.run_jobs_max));
      setRetAuditEventsMax(String(nextRetention.audit_events_max));
      setSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      setSyncSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      const ongoing = nextJobs.find((job) => isRunJobActive(job));
      if (ongoing) {
        setActiveRunJobID((prev) => prev || ongoing.id);
        setActiveRunJob((prev) => (prev && prev.id === ongoing.id ? prev : ongoing));
        setRunJobPolling(true);
      }
      setMessage(
        `loaded ${nextHosts.length} hosts, ${nextRuns.length} runs, ${nextAudit.length} events, ${nextJobs.length} jobs, queue=${nextMetrics.queue.depth}`
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!runJobPolling || !token.trim() || !activeRunJobID) {
      return;
    }
    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [job, jobs, nextMetrics] = await Promise.all([
          getRunJob(token, activeRunJobID),
          listRunJobs(token, 30, {
            status: parseCSV(jobStatusFilter),
            runtime: parseCSV(jobRuntimeFilter),
            host_id: jobHostFilter.trim() || undefined
          }),
          getMetrics(token)
        ]);
        if (canceled) return;
        setActiveRunJob(job);
        setRunJobs(jobs);
        setMetrics(nextMetrics);
        if (!isRunJobActive(job)) {
          setRunJobPolling(false);
          setRunStatus(job.result_status ?? null);
          if (isRunResponsePayload(job.response)) setRunResult(job.response);
          const [nextRuns, nextAudit] = await Promise.all([
            listRuns(token, 20),
            listAudit(token, 80, {
              status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
              action: auditActionFilter.trim() || undefined
            })
          ]);
          if (canceled) return;
          setRunHistory(nextRuns);
          setAuditEvents(nextAudit);
          setMessage(`job ${job.id} completed: ${job.status}, http=${job.result_status ?? "n/a"}`);
        }
      } catch (err) {
        if (canceled) return;
        setRunJobPolling(false);
        setMessage(`job polling error: ${String(err)}`);
      }
    }, 2000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [runJobPolling, token, activeRunJobID, jobStatusFilter, jobRuntimeFilter, jobHostFilter, auditStatusFilter, auditActionFilter]);

  async function onAddHost(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const hostRaw = String(form.get("host") ?? "").trim();
    const connectionModeRaw = String(form.get("connection_mode") ?? "").trim();
    const connectionMode: "ssh" | "local" = connectionModeRaw === "local" ? "local" : "ssh";
    const host = connectionMode === "local" ? hostRaw || "localhost" : hostRaw;
    const user = String(form.get("user") ?? "").trim();
    const workspace = String(form.get("workspace") ?? "").trim();
    const identityFile = String(form.get("identity_file") ?? "").trim();
    const sshProxyJump = String(form.get("ssh_proxy_jump") ?? "").trim();
    const sshHostKeyPolicyRaw = String(form.get("ssh_host_key_policy") ?? "").trim();
    const sshConnectTimeoutRaw = String(form.get("ssh_connect_timeout_sec") ?? "").trim();
    const sshAliveIntervalRaw = String(form.get("ssh_server_alive_interval_sec") ?? "").trim();
    const sshAliveCountRaw = String(form.get("ssh_server_alive_count_max") ?? "").trim();
    if (!name) {
      setMessage("name is required");
      return;
    }
    if (connectionMode === "ssh" && !host) {
      setMessage("host is required for ssh mode");
      return;
    }
    const parseOptionalInt = (raw: string, field: string, min: number, max: number): number | undefined => {
      if (!raw) return undefined;
      const v = Number.parseInt(raw, 10);
      if (!Number.isFinite(v) || v < min || v > max) {
        throw new Error(`${field} must be an integer in [${min}, ${max}]`);
      }
      return v;
    };
    try {
      const sshConnectTimeoutSec = parseOptionalInt(sshConnectTimeoutRaw, "ssh_connect_timeout_sec", 1, 300);
      const sshServerAliveIntervalSec = parseOptionalInt(sshAliveIntervalRaw, "ssh_server_alive_interval_sec", 1, 300);
      const sshServerAliveCountMax = parseOptionalInt(sshAliveCountRaw, "ssh_server_alive_count_max", 1, 10);
      let sshHostKeyPolicy: "accept-new" | "strict" | "insecure-ignore" | undefined = undefined;
      if (sshHostKeyPolicyRaw) {
        if (sshHostKeyPolicyRaw === "accept-new" || sshHostKeyPolicyRaw === "strict" || sshHostKeyPolicyRaw === "insecure-ignore") {
          sshHostKeyPolicy = sshHostKeyPolicyRaw;
        } else {
          throw new Error("ssh_host_key_policy must be one of: accept-new, strict, insecure-ignore");
        }
      }
      await upsertHost(token, {
        name,
        connection_mode: connectionMode,
        host,
        user,
        workspace,
        identity_file: identityFile || undefined,
        ssh_proxy_jump: sshProxyJump || undefined,
        ssh_host_key_policy: sshHostKeyPolicy,
        ssh_connect_timeout_sec: sshConnectTimeoutSec,
        ssh_server_alive_interval_sec: sshServerAliveIntervalSec,
        ssh_server_alive_count_max: sshServerAliveCountMax
      });
      setMessage(`host ${name} saved`);
      await refresh();
      e.currentTarget.reset();
    } catch (err) {
      setMessage(String(err));
    }
  }

  function toggleHost(id: string) {
    setSelectedHostIDs((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id);
      return [...prev, id];
    });
  }

  function toggleSyncHost(id: string) {
    setSyncSelectedHostIDs((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id);
      return [...prev, id];
    });
  }

  async function onRunCodex(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    if (runMode === "exec" && !runPrompt.trim()) {
      setMessage("prompt is required for exec mode");
      return;
    }
    if (runMode === "resume" && !runResumeLast && !runSessionID.trim()) {
      setMessage("session id is required when resume_last is disabled");
      return;
    }
    if (!runAllHosts && selectedHostIDs.length === 0) {
      setMessage("select at least one host or enable all hosts");
      return;
    }

    const fanout = Math.max(1, Number.parseInt(runFanoutValue, 10) || 1);
    const maxOutputKB = Math.max(32, Number.parseInt(runMaxOutputKB, 10) || 256);
    const retryCount = Math.max(0, Number.parseInt(runRetryCountValue, 10) || 0);
    const retryBackoffMS = Math.max(100, Number.parseInt(runRetryBackoffMSValue, 10) || 1000);
    setRunLoading(true);
    setRunResult(null);
    setRunStatus(null);
    setMessage("");
    try {
      const codex = {
        mode: runMode,
        model: runModel.trim() || undefined,
        sandbox: runMode === "exec" ? runSandbox || undefined : undefined,
        json_output: runJSONOutput,
        skip_git_repo_check: runSkipGitRepoCheck,
        ephemeral: runEphemeral,
        resume_last: runMode === "resume" ? runResumeLast : undefined,
        session_id: runMode === "resume" && !runResumeLast ? runSessionID.trim() : undefined
      };
      const runRequest = {
        runtime: "codex",
        prompt: runPrompt.trim(),
        fanout,
        max_output_kb: maxOutputKB,
        retry_count: retryCount,
        retry_backoff_ms: retryBackoffMS,
        all_hosts: runAllHosts,
        host_ids: runAllHosts ? undefined : selectedHostIDs,
        workdir: runWorkdir.trim() || undefined,
        codex
      };
      if (runAsyncMode) {
        const { status, body } = await enqueueRunJob(token, runRequest);
        setActiveRunJobID(body.job.id);
        setActiveRunJob(body.job);
        setRunJobPolling(isRunJobActive(body.job));
        setMessage(`run job accepted with HTTP ${status}: ${body.job.id}`);
        const [nextJobs, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(token, 30, {
            status: parseCSV(jobStatusFilter),
            runtime: parseCSV(jobRuntimeFilter),
            host_id: jobHostFilter.trim() || undefined
          }),
          listAudit(token, 80, {
            status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
            action: auditActionFilter.trim() || undefined
          }),
          getMetrics(token)
        ]);
        setRunJobs(nextJobs);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
      } else {
        const { status, body } = await runFanout(token, runRequest);
        setRunStatus(status);
        setRunResult(body);
        setMessage(`run finished with HTTP ${status}, failed=${body.summary.failed}`);
        const [nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRuns(token, 20),
          listAudit(token, 80, {
            status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
            action: auditActionFilter.trim() || undefined
          }),
          getMetrics(token)
        ]);
        setRunHistory(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
      }
    } catch (err) {
      setMessage(String(err));
    } finally {
      setRunLoading(false);
    }
  }

  async function onUseLatestSession() {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    if (runAllHosts || selectedHostIDs.length === 0) {
      setMessage("disable all-hosts and select one host first");
      return;
    }
    try {
      const hostID = selectedHostIDs[0];
      const { body } = await discoverCodexSessions(token, {
        host_id: hostID,
        limit_per_host: 1,
        timeout_sec: 60
      });
      const target = body.targets?.[0];
      const session = target?.sessions?.[0];
      if (!session?.session_id) {
        setMessage("no resumable codex session found on selected host");
        return;
      }
      setRunMode("resume");
      setRunResumeLast(false);
      setRunSessionID(session.session_id);
      setMessage(`selected latest session: ${session.session_id}`);
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function onSyncHosts(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    if (!syncSrc.trim() || !syncDst.trim()) {
      setMessage("sync src and dst are required");
      return;
    }
    if (!syncAllHosts && syncSelectedHostIDs.length === 0) {
      setMessage("select at least one host or enable sync all hosts");
      return;
    }

    const fanout = Math.max(1, Number.parseInt(syncFanoutValue, 10) || 1);
    const maxOutputKB = Math.max(32, Number.parseInt(syncMaxOutputKB, 10) || 256);
    const retryCount = Math.max(0, Number.parseInt(syncRetryCountValue, 10) || 0);
    const retryBackoffMS = Math.max(100, Number.parseInt(syncRetryBackoffMSValue, 10) || 1000);
    const excludes = syncExcludes
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

    setSyncLoading(true);
    setSyncStatus(null);
    setSyncResult(null);
    setMessage("");
    try {
      const syncRequest = {
        src: syncSrc.trim(),
        dst: syncDst.trim(),
        fanout,
        max_output_kb: maxOutputKB,
        retry_count: retryCount,
        retry_backoff_ms: retryBackoffMS,
        all_hosts: syncAllHosts,
        host_ids: syncAllHosts ? undefined : syncSelectedHostIDs,
        delete: syncDelete,
        excludes: excludes.length > 0 ? excludes : undefined
      };
      if (syncAsyncMode) {
        const { status, body } = await enqueueSyncJob(token, syncRequest);
        setActiveRunJobID(body.job.id);
        setActiveRunJob(body.job);
        setRunJobPolling(isRunJobActive(body.job));
        setMessage(`sync job accepted with HTTP ${status}: ${body.job.id}`);
        const [nextJobs, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(token, 30, {
            status: parseCSV(jobStatusFilter),
            runtime: parseCSV(jobRuntimeFilter),
            host_id: jobHostFilter.trim() || undefined
          }),
          listAudit(token, 80, {
            status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
            action: auditActionFilter.trim() || undefined
          }),
          getMetrics(token)
        ]);
        setRunJobs(nextJobs);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
      } else {
        const { status, body } = await syncHosts(token, syncRequest);
        setSyncStatus(status);
        setSyncResult(body);
        setMessage(`sync finished with HTTP ${status}, failed=${body.summary.failed}`);
        const [nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRuns(token, 20),
          listAudit(token, 80, {
            status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
            action: auditActionFilter.trim() || undefined
          }),
          getMetrics(token)
        ]);
        setRunHistory(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
      }
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSyncLoading(false);
    }
  }

  async function onCancelJob(jobID: string) {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    try {
      const { state, job } = await cancelRunJob(token, jobID);
      setMessage(`job ${jobID}: ${state}`);
      setActiveRunJobID(jobID);
      setActiveRunJob(job);
      const [nextJobs, nextAudit, nextMetrics] = await Promise.all([
        listRunJobs(token, 30, {
          status: parseCSV(jobStatusFilter),
          runtime: parseCSV(jobRuntimeFilter),
          host_id: jobHostFilter.trim() || undefined
        }),
        listAudit(token, 80, {
          status: auditStatusFilter ? Number.parseInt(auditStatusFilter, 10) || undefined : undefined,
          action: auditActionFilter.trim() || undefined
        }),
        getMetrics(token)
      ]);
      setRunJobs(nextJobs);
      setAuditEvents(nextAudit);
      setMetrics(nextMetrics);
      if (!isRunJobActive(job)) {
        setRunJobPolling(false);
      }
    } catch (err) {
      setMessage(String(err));
    }
  }

  async function onApplyRetention() {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    try {
      const next = await setRetentionPolicy(token, {
        run_records_max: Math.max(100, Number.parseInt(retRunRecordsMax, 10) || 100),
        run_jobs_max: Math.max(100, Number.parseInt(retRunJobsMax, 10) || 100),
        audit_events_max: Math.max(100, Number.parseInt(retAuditEventsMax, 10) || 100)
      });
      setRetention(next);
      setRetRunRecordsMax(String(next.run_records_max));
      setRetRunJobsMax(String(next.run_jobs_max));
      setRetAuditEventsMax(String(next.audit_events_max));
      setMessage("retention policy updated");
      const nextMetrics = await getMetrics(token);
      setMetrics(nextMetrics);
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <div className="page">
      <header>
        <h1>remote-llm console</h1>
        <p>Universal runtime controller. Codex runtime is enabled first.</p>
      </header>

      <section className="card">
        <h2>Server</h2>
        <p>Health: {health}</p>
      </section>

      <section className="card">
        <h2>Access Key</h2>
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            localStorage.setItem(TOKEN_KEY, e.target.value);
          }}
          placeholder="rlm_xxx.yyy"
        />
        <button onClick={refresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </section>

      <section className="card">
        <h2>Control Plane Metrics</h2>
        {metrics ? (
          <p>
            queue_depth={metrics.queue.depth} workers={metrics.queue.workers_active}/{metrics.queue.workers_total} util=
            {(metrics.queue.worker_utilization * 100).toFixed(1)}% success_rate={(metrics.success_rate * 100).toFixed(1)}% pending=
            {metrics.jobs.pending} running={metrics.jobs.running} failed={metrics.jobs.failed} canceled={metrics.jobs.canceled} retry_attempts=
            {metrics.jobs.retry_attempts}
          </p>
        ) : (
          <p>no metrics loaded yet</p>
        )}
      </section>

      <section className="card">
        <h2>Retention Policy</h2>
        <form
          className="grid"
          onSubmit={(e) => {
            e.preventDefault();
            void onApplyRetention();
          }}
        >
          <label>
            run records max
            <input value={retRunRecordsMax} onChange={(e) => setRetRunRecordsMax(e.target.value)} />
          </label>
          <label>
            run jobs max
            <input value={retRunJobsMax} onChange={(e) => setRetRunJobsMax(e.target.value)} />
          </label>
          <label>
            audit events max
            <input value={retAuditEventsMax} onChange={(e) => setRetAuditEventsMax(e.target.value)} />
          </label>
          <button type="submit">Apply Retention</button>
        </form>
        {retention ? (
          <p>
            current: runs={retention.run_records_max} jobs={retention.run_jobs_max} audit={retention.audit_events_max}
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Runtimes</h2>
        <ul>
          {runtimes.map((r) => (
            <li key={r.name}>
              <code>{r.name}</code> non-interactive={String(r.capabilities.supports_non_interactive_exec)}
              {r.contract ? ` contract=${r.contract.version} prompt_required=${String(r.contract.prompt_required)}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Add Host</h2>
        <form onSubmit={onAddHost} className="grid">
          <input name="name" placeholder="name" required />
          <label>
            connection mode
            <select name="connection_mode" defaultValue="ssh">
              <option value="ssh">ssh</option>
              <option value="local">local</option>
            </select>
          </label>
          <input name="host" placeholder="hostname or ip (local mode allows empty)" />
          <input name="user" placeholder="user" />
          <input name="workspace" placeholder="/home/user/workspace" />
          <input name="identity_file" placeholder="identity file (optional), e.g. ~/.ssh/id_ed25519" />
          <input name="ssh_proxy_jump" placeholder="ssh proxy jump (optional), e.g. jump@bastion:22" />
          <label>
            host key policy
            <select name="ssh_host_key_policy" defaultValue="accept-new">
              <option value="accept-new">accept-new</option>
              <option value="strict">strict</option>
              <option value="insecure-ignore">insecure-ignore</option>
            </select>
          </label>
          <input name="ssh_connect_timeout_sec" placeholder="ssh connect timeout sec (1-300)" />
          <input name="ssh_server_alive_interval_sec" placeholder="ssh keepalive interval sec (1-300)" />
          <input name="ssh_server_alive_count_max" placeholder="ssh keepalive count max (1-10)" />
          <button type="submit">Save Host</button>
        </form>
      </section>

      <section className="card">
        <h2>Hosts</h2>
        <ul>
          {hosts.map((h) => (
            <li key={h.id}>
              <strong>{h.name}</strong> {h.user ? `${h.user}@` : ""}
              {h.host}:{h.port}
              {h.connection_mode ? ` mode=${h.connection_mode}` : " mode=ssh"}
              {h.workspace ? ` (${h.workspace})` : ""}
              {h.ssh_proxy_jump ? ` proxy_jump=${h.ssh_proxy_jump}` : ""}
              {h.ssh_host_key_policy ? ` host_key=${h.ssh_host_key_policy}` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Run Codex (Fanout)</h2>
        <form onSubmit={onRunCodex} className="grid">
          <label>
            mode
            <select value={runMode} onChange={(e) => setRunMode(e.target.value as "exec" | "resume" | "review")}>
              <option value="exec">exec</option>
              <option value="resume">resume</option>
              <option value="review">review</option>
            </select>
          </label>
          <label>
            model
            <input value={runModel} onChange={(e) => setRunModel(e.target.value)} placeholder="optional model" />
          </label>
          <label>
            sandbox
            <select
              value={runSandbox}
              onChange={(e) =>
                setRunSandbox(e.target.value as "" | "read-only" | "workspace-write" | "danger-full-access")
              }
            >
              <option value="">default</option>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </label>
          <label>
            max output KB
            <input value={runMaxOutputKB} onChange={(e) => setRunMaxOutputKB(e.target.value)} />
          </label>
          <textarea
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
            placeholder={runMode === "exec" ? "prompt (required for exec)" : "optional prompt"}
            rows={4}
            className="wide"
          />
          {runMode === "resume" ? (
            <>
              <label className="inline">
                <input type="checkbox" checked={runResumeLast} onChange={(e) => setRunResumeLast(e.target.checked)} />
                resume last session
              </label>
              {!runResumeLast ? (
                <input
                  value={runSessionID}
                  onChange={(e) => setRunSessionID(e.target.value)}
                  placeholder="session id"
                  className="wide"
                />
              ) : null}
              <button type="button" onClick={onUseLatestSession}>
                Use Latest Session On Selected Host
              </button>
            </>
          ) : null}
          <input
            value={runWorkdir}
            onChange={(e) => setRunWorkdir(e.target.value)}
            placeholder="optional workdir override"
            className="wide"
          />
          <label>
            fanout
            <input value={runFanoutValue} onChange={(e) => setRunFanoutValue(e.target.value)} />
          </label>
          <label>
            retry count
            <input value={runRetryCountValue} onChange={(e) => setRunRetryCountValue(e.target.value)} />
          </label>
          <label>
            retry backoff ms
            <input value={runRetryBackoffMSValue} onChange={(e) => setRunRetryBackoffMSValue(e.target.value)} />
          </label>
          <label className="inline">
            <input type="checkbox" checked={runAllHosts} onChange={(e) => setRunAllHosts(e.target.checked)} />
            all hosts
          </label>
          <label className="inline">
            <input type="checkbox" checked={runAsyncMode} onChange={(e) => setRunAsyncMode(e.target.checked)} />
            async job mode
          </label>
          <label className="inline">
            <input type="checkbox" checked={runJSONOutput} onChange={(e) => setRunJSONOutput(e.target.checked)} />
            codex --json
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={runSkipGitRepoCheck}
              onChange={(e) => setRunSkipGitRepoCheck(e.target.checked)}
            />
            skip git repo check
          </label>
          <label className="inline">
            <input type="checkbox" checked={runEphemeral} onChange={(e) => setRunEphemeral(e.target.checked)} />
            ephemeral session
          </label>
          <button type="submit" disabled={runLoading}>
            {runLoading ? (runAsyncMode ? "Queueing..." : "Running...") : runAsyncMode ? "Queue Codex Run" : "Run Codex"}
          </button>
        </form>

        {!runAllHosts ? (
          <div className="host-grid">
            {hosts.map((h) => (
              <label key={h.id} className="inline">
                <input type="checkbox" checked={selectedHostIDs.includes(h.id)} onChange={() => toggleHost(h.id)} />
                {h.name}
              </label>
            ))}
          </div>
        ) : null}

        {runResult ? (
          <div className="run-result">
            <p>
              status={runStatus} total={runResult.summary.total} ok={runResult.summary.succeeded} failed=
              {runResult.summary.failed} fanout={runResult.summary.fanout} retry={runResult.summary.retry_count ?? 0}
              /{runResult.summary.retry_backoff_ms ?? 0}ms duration={runResult.summary.duration_ms}ms
            </p>
            <ul>
              {runResult.targets.map((t) => (
                <li key={t.host.id}>
                  <strong>{t.host.name}</strong> ok={String(t.ok)} exit={t.result.exit_code ?? "n/a"} dur=
                  {t.result.duration_ms ?? 0}ms stdout={t.result.stdout_bytes ?? 0}B stderr={t.result.stderr_bytes ?? 0}
                  B attempts={t.attempts ?? 1}
                  {t.result.stdout_truncated ? " stdout_truncated=true" : ""}
                  {t.result.stderr_truncated ? " stderr_truncated=true" : ""}
                  {t.codex ? ` codex_events=${t.codex.event_count} invalid_json_lines=${t.codex.invalid_lines ?? 0}` : ""}
                  {t.error_class ? ` error_class=${t.error_class}` : ""}
                  {t.error_hint ? ` hint=${t.error_hint}` : ""}
                  {t.error ? ` error=${t.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Run Jobs</h2>
        <div className="grid">
          <input
            value={jobStatusFilter}
            onChange={(e) => setJobStatusFilter(e.target.value)}
            placeholder="status csv: pending,running,failed"
          />
          <input
            value={jobRuntimeFilter}
            onChange={(e) => setJobRuntimeFilter(e.target.value)}
            placeholder="runtime csv: codex,sync"
          />
          <input value={jobHostFilter} onChange={(e) => setJobHostFilter(e.target.value)} placeholder="host id filter (optional)" />
        </div>
        {activeRunJob ? (
          <p>
            active={activeRunJob.id} status={activeRunJob.status} runtime={activeRunJob.runtime} total=
            {activeRunJob.total_hosts ?? 0} ok={activeRunJob.succeeded_hosts ?? 0} failed={activeRunJob.failed_hosts ?? 0}
            http={activeRunJob.result_status ?? "n/a"} {runJobPolling ? "polling=true" : "polling=false"}
            {activeRunJob.error ? ` error=${activeRunJob.error}` : ""}
          </p>
        ) : (
          <p>no active run job</p>
        )}
        {runJobs.length === 0 ? (
          <p>no run jobs yet</p>
        ) : (
          <ul>
            {runJobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveRunJobID(job.id);
                    setActiveRunJob(job);
                    setRunJobPolling(isRunJobActive(job));
                  }}
                >
                  watch
                </button>{" "}
                {isRunJobCancelable(job) ? (
                  <button type="button" onClick={() => onCancelJob(job.id)}>
                    cancel
                  </button>
                ) : null}{" "}
                <strong>{job.id}</strong> type={job.type} status={job.status} runtime={job.runtime} hosts={job.total_hosts ?? 0} ok=
                {job.succeeded_hosts ?? 0} failed={job.failed_hosts ?? 0} http={job.result_status ?? "n/a"} dur=
                {job.duration_ms ?? 0}ms
                {job.error ? ` error=${job.error}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Sync Files (rsync)</h2>
        <form onSubmit={onSyncHosts} className="grid">
          <input value={syncSrc} onChange={(e) => setSyncSrc(e.target.value)} placeholder="local src path (controller)" className="wide" />
          <input value={syncDst} onChange={(e) => setSyncDst(e.target.value)} placeholder="remote dst path" className="wide" />
          <label>
            fanout
            <input value={syncFanoutValue} onChange={(e) => setSyncFanoutValue(e.target.value)} />
          </label>
          <label>
            max output KB
            <input value={syncMaxOutputKB} onChange={(e) => setSyncMaxOutputKB(e.target.value)} />
          </label>
          <label>
            retry count
            <input value={syncRetryCountValue} onChange={(e) => setSyncRetryCountValue(e.target.value)} />
          </label>
          <label>
            retry backoff ms
            <input value={syncRetryBackoffMSValue} onChange={(e) => setSyncRetryBackoffMSValue(e.target.value)} />
          </label>
          <input
            value={syncExcludes}
            onChange={(e) => setSyncExcludes(e.target.value)}
            placeholder="excludes (comma separated), e.g. .git,node_modules"
            className="wide"
          />
          <label className="inline">
            <input type="checkbox" checked={syncAllHosts} onChange={(e) => setSyncAllHosts(e.target.checked)} />
            all hosts
          </label>
          <label className="inline">
            <input type="checkbox" checked={syncAsyncMode} onChange={(e) => setSyncAsyncMode(e.target.checked)} />
            async job mode
          </label>
          <label className="inline">
            <input type="checkbox" checked={syncDelete} onChange={(e) => setSyncDelete(e.target.checked)} />
            delete extra remote files
          </label>
          <button type="submit" disabled={syncLoading}>
            {syncLoading ? (syncAsyncMode ? "Queueing..." : "Syncing...") : syncAsyncMode ? "Queue Sync Job" : "Sync"}
          </button>
        </form>

        {!syncAllHosts ? (
          <div className="host-grid">
            {hosts.map((h) => (
              <label key={h.id} className="inline">
                <input
                  type="checkbox"
                  checked={syncSelectedHostIDs.includes(h.id)}
                  onChange={() => toggleSyncHost(h.id)}
                />
                {h.name}
              </label>
            ))}
          </div>
        ) : null}

        {syncResult ? (
          <div className="run-result">
            <p>
              status={syncStatus} total={syncResult.summary.total} ok={syncResult.summary.succeeded} failed=
              {syncResult.summary.failed} fanout={syncResult.summary.fanout} retry={syncResult.summary.retry_count ?? 0}
              /{syncResult.summary.retry_backoff_ms ?? 0}ms duration={syncResult.summary.duration_ms}ms
            </p>
            <ul>
              {syncResult.targets.map((t) => (
                <li key={t.host.id}>
                  <strong>{t.host.name}</strong> ok={String(t.ok)} exit={t.result.exit_code ?? "n/a"} dur=
                  {t.result.duration_ms ?? 0}ms stdout={t.result.stdout_bytes ?? 0}B stderr={t.result.stderr_bytes ?? 0}
                  B attempts={t.attempts ?? 1}
                  {t.result.stdout_truncated ? " stdout_truncated=true" : ""}
                  {t.result.stderr_truncated ? " stderr_truncated=true" : ""}
                  {t.error_class ? ` error_class=${t.error_class}` : ""}
                  {t.error_hint ? ` hint=${t.error_hint}` : ""}
                  {t.error ? ` error=${t.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Recent Runs</h2>
        {runHistory.length === 0 ? (
          <p>no runs yet</p>
        ) : (
          <ul>
            {runHistory.map((r) => (
              <li key={r.id}>
                <strong>{r.runtime}</strong> http={r.status_code} hosts={r.total_hosts} ok={r.succeeded_hosts} failed=
                {r.failed_hosts} fanout={r.fanout} dur={r.duration_ms}ms prompt="{r.prompt_preview}"
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Audit Events</h2>
        <div className="grid">
          <input
            value={auditStatusFilter}
            onChange={(e) => setAuditStatusFilter(e.target.value)}
            placeholder="status code filter, e.g. 200"
          />
          <input
            value={auditActionFilter}
            onChange={(e) => setAuditActionFilter(e.target.value)}
            placeholder="action filter, e.g. job.cancel"
          />
        </div>
        {auditEvents.length === 0 ? (
          <p>no audit events yet</p>
        ) : (
          <ul>
            {auditEvents.map((e) => (
              <li key={e.id}>
                <code>{e.timestamp}</code> {e.action} {e.method} {e.path} status={e.status_code} dur={e.duration_ms}ms
                {e.created_by_key_id ? ` key=${e.created_by_key_id}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer>{message}</footer>
    </div>
  );
}
