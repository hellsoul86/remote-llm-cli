import { FormEvent, useEffect, useState } from "react";
import {
  enqueueRunJob,
  getRunJob,
  healthz,
  listAudit,
  listHosts,
  listRunJobs,
  listRuns,
  listRuntimes,
  runFanout,
  syncHosts,
  upsertHost,
  type AuditEvent,
  type Host,
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
  const [activeRunJobID, setActiveRunJobID] = useState("");
  const [activeRunJob, setActiveRunJob] = useState<RunJobRecord | null>(null);
  const [runJobPolling, setRunJobPolling] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
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

  useEffect(() => {
    healthz()
      .then((h) => setHealth(`ok (${h.timestamp})`))
      .catch((e) => setHealth(`error: ${String(e)}`));
  }, []);

  function isRunJobActive(job: RunJobRecord | null | undefined): boolean {
    if (!job) return false;
    return job.status === "pending" || job.status === "running";
  }

  async function refresh() {
    if (!token.trim()) {
      setMessage("set access key first");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const [nextHosts, nextRuntimes, nextRuns, nextAudit, nextJobs] = await Promise.all([
        listHosts(token),
        listRuntimes(token),
        listRuns(token, 20),
        listAudit(token, 80),
        listRunJobs(token, 30)
      ]);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setRunHistory(nextRuns);
      setAuditEvents(nextAudit);
      setRunJobs(nextJobs);
      setSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      setSyncSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      const ongoing = nextJobs.find((job) => isRunJobActive(job));
      if (ongoing) {
        setActiveRunJobID((prev) => prev || ongoing.id);
        setActiveRunJob((prev) => (prev && prev.id === ongoing.id ? prev : ongoing));
        setRunJobPolling(true);
      }
      setMessage(`loaded ${nextHosts.length} hosts, ${nextRuns.length} runs, ${nextAudit.length} events, ${nextJobs.length} jobs`);
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
        const [job, jobs] = await Promise.all([getRunJob(token, activeRunJobID), listRunJobs(token, 30)]);
        if (canceled) return;
        setActiveRunJob(job);
        setRunJobs(jobs);
        if (!isRunJobActive(job)) {
          setRunJobPolling(false);
          setRunStatus(job.result_status ?? null);
          if (job.response) setRunResult(job.response);
          const [nextRuns, nextAudit] = await Promise.all([listRuns(token, 20), listAudit(token, 80)]);
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
  }, [runJobPolling, token, activeRunJobID]);

  async function onAddHost(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const host = String(form.get("host") ?? "").trim();
    const user = String(form.get("user") ?? "").trim();
    const workspace = String(form.get("workspace") ?? "").trim();
    if (!name || !host) {
      setMessage("name and host are required");
      return;
    }
    try {
      await upsertHost(token, { name, host, user, workspace });
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
        const [nextJobs, nextAudit] = await Promise.all([listRunJobs(token, 30), listAudit(token, 80)]);
        setRunJobs(nextJobs);
        setAuditEvents(nextAudit);
      } else {
        const { status, body } = await runFanout(token, runRequest);
        setRunStatus(status);
        setRunResult(body);
        setMessage(`run finished with HTTP ${status}, failed=${body.summary.failed}`);
        const [nextRuns, nextAudit] = await Promise.all([listRuns(token, 20), listAudit(token, 80)]);
        setRunHistory(nextRuns);
        setAuditEvents(nextAudit);
      }
    } catch (err) {
      setMessage(String(err));
    } finally {
      setRunLoading(false);
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
      const { status, body } = await syncHosts(token, {
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
      });
      setSyncStatus(status);
      setSyncResult(body);
      setMessage(`sync finished with HTTP ${status}, failed=${body.summary.failed}`);
      const [nextRuns, nextAudit] = await Promise.all([listRuns(token, 20), listAudit(token, 80)]);
      setRunHistory(nextRuns);
      setAuditEvents(nextAudit);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setSyncLoading(false);
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
        <h2>Runtimes</h2>
        <ul>
          {runtimes.map((r) => (
            <li key={r.name}>
              <code>{r.name}</code> non-interactive={String(r.capabilities.supports_non_interactive_exec)}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Add Host</h2>
        <form onSubmit={onAddHost} className="grid">
          <input name="name" placeholder="name" required />
          <input name="host" placeholder="hostname or ip" required />
          <input name="user" placeholder="user" />
          <input name="workspace" placeholder="/home/user/workspace" />
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
              {h.workspace ? ` (${h.workspace})` : ""}
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
                  {t.error ? ` error=${t.error}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>Run Jobs</h2>
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
                <strong>{job.id}</strong> status={job.status} runtime={job.runtime} hosts={job.total_hosts ?? 0} ok=
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
            <input type="checkbox" checked={syncDelete} onChange={(e) => setSyncDelete(e.target.checked)} />
            delete extra remote files
          </label>
          <button type="submit" disabled={syncLoading}>
            {syncLoading ? "Syncing..." : "Sync"}
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
