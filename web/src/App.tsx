import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  enqueueRunJob,
  getMetrics,
  getRunJob,
  healthz,
  listHosts,
  listRunJobs,
  listRuns,
  listRuntimes,
  runFanout,
  upsertHost,
  type Host,
  type MetricsResponse,
  type RunJobRecord,
  type RunRecord,
  type RunRequest,
  type RunResponse,
  type RuntimeInfo
} from "./api";

const TOKEN_KEY = "remote_llm_access_key";

type AuthPhase = "checking" | "locked" | "ready";
type TimelineKind = "user" | "assistant" | "system";
type TimelineState = "running" | "success" | "error";

type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  body: string;
  state?: TimelineState;
  createdAt: string;
};

type AddHostForm = {
  name: string;
  host: string;
  user: string;
  workspace: string;
};

function isJobActive(job: RunJobRecord | null | undefined): boolean {
  if (!job) return false;
  return job.status === "pending" || job.status === "running";
}

function isRunResponsePayload(value: unknown): value is RunResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.runtime === "string" && typeof candidate.summary === "object" && Array.isArray(candidate.targets);
}

function summarizeRunResponse(response: RunResponse): string {
  const lines = [
    `runtime=${response.runtime}`,
    `total=${response.summary.total} succeeded=${response.summary.succeeded} failed=${response.summary.failed}`,
    `fanout=${response.summary.fanout} duration=${response.summary.duration_ms}ms`
  ];
  for (const target of response.targets) {
    const status = target.ok ? "ok" : "failed";
    const exit = target.result.exit_code ?? "n/a";
    const hint = target.error_hint ? ` hint=${target.error_hint}` : "";
    const err = target.error ? ` error=${target.error}` : "";
    lines.push(`${target.host.name}: ${status} exit=${exit}${hint}${err}`);
  }
  return lines.join("\n");
}

function formatShortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function App() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [authError, setAuthError] = useState("");

  const [health, setHealth] = useState("checking");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [jobs, setJobs] = useState<RunJobRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);

  const [selectedRuntime, setSelectedRuntime] = useState("codex");
  const [allHosts, setAllHosts] = useState(true);
  const [selectedHostIDs, setSelectedHostIDs] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<"exec" | "resume" | "review">("exec");
  const [runModel, setRunModel] = useState("");
  const [runSandbox, setRunSandbox] = useState<"" | "read-only" | "workspace-write" | "danger-full-access">("");
  const [runAsyncMode, setRunAsyncMode] = useState(true);
  const [prompt, setPrompt] = useState("summarize current repo state and risks");
  const [workdir, setWorkdir] = useState("");
  const [fanoutValue, setFanoutValue] = useState("3");
  const [maxOutputKB, setMaxOutputKB] = useState("256");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [activeJobID, setActiveJobID] = useState("");
  const [activeJob, setActiveJob] = useState<RunJobRecord | null>(null);
  const [completedJobMessages, setCompletedJobMessages] = useState<string[]>([]);

  const [hostForm, setHostForm] = useState<AddHostForm>({ name: "", host: "", user: "", workspace: "" });
  const [addingHost, setAddingHost] = useState(false);

  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);

  const entryCounter = useRef(0);
  const timelineBottomRef = useRef<HTMLDivElement | null>(null);

  const selectedHostCount = allHosts ? hosts.length : selectedHostIDs.length;

  const activeRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.name === selectedRuntime) ?? runtimes[0] ?? null,
    [runtimes, selectedRuntime]
  );

  function nextEntryID(): string {
    entryCounter.current += 1;
    return `entry_${Date.now()}_${entryCounter.current}`;
  }

  function addTimelineEntry(entry: Omit<TimelineEntry, "id" | "createdAt">) {
    setTimeline((prev) => [
      ...prev,
      {
        id: nextEntryID(),
        createdAt: new Date().toISOString(),
        ...entry
      }
    ]);
  }

  async function loadWorkspace(authToken: string, emitSystemNote: boolean) {
    setIsRefreshing(true);
    try {
      const [healthBody, nextHosts, nextRuntimes, nextJobs, nextRuns, nextMetrics] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        getMetrics(authToken)
      ]);

      setHealth(`ok ${healthBody.timestamp}`);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setMetrics(nextMetrics);

      setSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((h) => h.id === id)));
      if (!nextRuntimes.some((runtime) => runtime.name === selectedRuntime)) {
        setSelectedRuntime(nextRuntimes[0]?.name ?? "codex");
      }

      const running = nextJobs.find((job) => isJobActive(job));
      if (running) {
        setActiveJobID(running.id);
        setActiveJob(running);
      }

      if (emitSystemNote) {
        addTimelineEntry({
          kind: "system",
          state: "success",
          title: "Connected",
          body: `Connected. hosts=${nextHosts.length} runtimes=${nextRuntimes.length} queue_depth=${nextMetrics.queue.depth}`
        });
      }
    } catch (error) {
      setHealth(`error: ${String(error)}`);
      if (emitSystemNote) {
        addTimelineEntry({
          kind: "system",
          state: "error",
          title: "Connection Failed",
          body: String(error)
        });
      }
      throw error;
    } finally {
      setIsRefreshing(false);
    }
  }

  async function unlockWorkspace(candidateToken: string) {
    const trimmed = candidateToken.trim();
    if (!trimmed) {
      setAuthError("token is required");
      setAuthPhase("locked");
      return;
    }

    setAuthPhase("checking");
    setAuthError("");

    try {
      await Promise.all([listRuntimes(trimmed), listHosts(trimmed)]);
      localStorage.setItem(TOKEN_KEY, trimmed);
      setToken(trimmed);
      setTokenInput(trimmed);
      setAuthPhase("ready");
      await loadWorkspace(trimmed, true);
    } catch (error) {
      localStorage.removeItem(TOKEN_KEY);
      setToken("");
      setAuthPhase("locked");
      setAuthError(`token validation failed: ${String(error)}`);
    }
  }

  useEffect(() => {
    const cached = localStorage.getItem(TOKEN_KEY) ?? "";
    if (!cached.trim()) {
      setAuthPhase("locked");
      return;
    }
    void unlockWorkspace(cached);
  }, []);

  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [timeline.length]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim() || !activeJobID) return;

    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [job, nextJobs, nextMetrics] = await Promise.all([
          getRunJob(token, activeJobID),
          listRunJobs(token, 20),
          getMetrics(token)
        ]);
        if (canceled) return;

        setActiveJob(job);
        setJobs(nextJobs);
        setMetrics(nextMetrics);

        if (!isJobActive(job)) {
          setActiveJobID("");
          setIsSubmitting(false);

          if (!completedJobMessages.includes(job.id)) {
            setCompletedJobMessages((prev) => [...prev, job.id]);
            if (isRunResponsePayload(job.response)) {
              addTimelineEntry({
                kind: "assistant",
                state: job.status === "succeeded" ? "success" : "error",
                title: `Job ${job.id} ${job.status}`,
                body: summarizeRunResponse(job.response)
              });
            } else {
              addTimelineEntry({
                kind: "assistant",
                state: job.status === "succeeded" ? "success" : "error",
                title: `Job ${job.id} ${job.status}`,
                body: job.error ? String(job.error) : `runtime=${job.runtime} status=${job.status}`
              });
            }
          }

          const [nextRuns, refreshedMetrics] = await Promise.all([listRuns(token, 20), getMetrics(token)]);
          if (canceled) return;
          setRuns(nextRuns);
          setMetrics(refreshedMetrics);
        }
      } catch (error) {
        if (canceled) return;
        addTimelineEntry({
          kind: "system",
          state: "error",
          title: "Job Poll Failed",
          body: String(error)
        });
        setActiveJobID("");
        setIsSubmitting(false);
      }
    }, 2200);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [authPhase, token, activeJobID, completedJobMessages]);

  async function onSubmitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await unlockWorkspace(tokenInput);
  }

  function onLogout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setTokenInput("");
    setHosts([]);
    setRuntimes([]);
    setJobs([]);
    setRuns([]);
    setMetrics(null);
    setTimeline([]);
    setActiveJob(null);
    setActiveJobID("");
    setCompletedJobMessages([]);
    setAuthError("");
    setAuthPhase("locked");
  }

  function toggleHostSelection(hostID: string) {
    setSelectedHostIDs((prev) => {
      if (prev.includes(hostID)) return prev.filter((id) => id !== hostID);
      return [...prev, hostID];
    });
  }

  async function onRefreshWorkspace() {
    if (authPhase !== "ready" || !token.trim()) return;
    await loadWorkspace(token, false);
  }

  async function onSendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      addTimelineEntry({ kind: "system", state: "error", title: "Prompt Missing", body: "Prompt is required." });
      return;
    }
    if (!allHosts && selectedHostIDs.length === 0) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "No Target Host",
        body: "Select at least one host or switch to all-host mode."
      });
      return;
    }

    const fanout = Math.max(1, Number.parseInt(fanoutValue, 10) || 1);
    const outputCap = Math.max(32, Number.parseInt(maxOutputKB, 10) || 256);

    const request: RunRequest = {
      runtime: activeRuntime?.name ?? selectedRuntime,
      prompt: trimmedPrompt,
      all_hosts: allHosts,
      host_ids: allHosts ? undefined : selectedHostIDs,
      workdir: workdir.trim() || undefined,
      fanout,
      max_output_kb: outputCap,
      codex:
        (activeRuntime?.name ?? selectedRuntime) === "codex"
          ? {
              mode: runMode,
              model: runModel.trim() || undefined,
              sandbox: runSandbox || undefined,
              json_output: true,
              skip_git_repo_check: false,
              ephemeral: false
            }
          : undefined
    };

    addTimelineEntry({
      kind: "user",
      title: `Run ${request.runtime}`,
      body: `${trimmedPrompt}\n\nmode=${runMode} async=${String(runAsyncMode)} hosts=${allHosts ? "all" : selectedHostIDs.join(",")}`
    });

    setIsSubmitting(true);
    try {
      if (runAsyncMode) {
        const { body } = await enqueueRunJob(token, request);
        setActiveJobID(body.job.id);
        setActiveJob(body.job);
        setJobs((prev) => [body.job, ...prev.filter((job) => job.id !== body.job.id)]);
        addTimelineEntry({
          kind: "system",
          state: "running",
          title: "Job Queued",
          body: `Job ${body.job.id} accepted. status=${body.job.status}`
        });
      } else {
        const { status, body } = await runFanout(token, request);
        addTimelineEntry({
          kind: "assistant",
          state: status >= 400 ? "error" : "success",
          title: `Run Finished (HTTP ${status})`,
          body: summarizeRunResponse(body)
        });
        const [nextRuns, nextJobs, nextMetrics] = await Promise.all([listRuns(token, 20), listRunJobs(token, 20), getMetrics(token)]);
        setRuns(nextRuns);
        setJobs(nextJobs);
        setMetrics(nextMetrics);
        setIsSubmitting(false);
      }
    } catch (error) {
      addTimelineEntry({ kind: "system", state: "error", title: "Run Failed", body: String(error) });
      setIsSubmitting(false);
    }
  }

  async function onAddHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;

    if (!hostForm.name.trim() || !hostForm.host.trim()) {
      addTimelineEntry({ kind: "system", state: "error", title: "Host Validation", body: "name and host are required." });
      return;
    }

    setAddingHost(true);
    try {
      await upsertHost(token, {
        name: hostForm.name.trim(),
        host: hostForm.host.trim(),
        user: hostForm.user.trim() || undefined,
        workspace: hostForm.workspace.trim() || undefined
      });
      setHostForm({ name: "", host: "", user: "", workspace: "" });
      await loadWorkspace(token, false);
      addTimelineEntry({ kind: "system", state: "success", title: "Host Saved", body: `Saved host ${hostForm.name.trim()}.` });
    } catch (error) {
      addTimelineEntry({ kind: "system", state: "error", title: "Host Save Failed", body: String(error) });
    } finally {
      setAddingHost(false);
    }
  }

  if (authPhase !== "ready") {
    return (
      <div className="lockscreen-root">
        <section className="lockscreen-card">
          <p className="eyebrow">remote-llm web workspace</p>
          <h1>Token-Gated Access</h1>
          <p>Enter your access key to unlock controller operations.</p>
          <form onSubmit={onSubmitToken} className="lockscreen-form">
            <label>
              Access Token
              <input
                placeholder="rlm_xxx.yyy"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={authPhase === "checking"}>
              {authPhase === "checking" ? "Unlocking..." : "Unlock Workspace"}
            </button>
          </form>
          {authError ? <p className="lockscreen-error">{authError}</p> : null}
          <p className="lockscreen-hint">API base: {(import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8080"}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">remote-llm</p>
          <h1>Codex-style Control Room</h1>
        </div>
        <div className="topbar-actions">
          <span className="health-pill">{health}</span>
          <button onClick={() => void onRefreshWorkspace()} disabled={isRefreshing}>
            {isRefreshing ? "Syncing..." : "Sync"}
          </button>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="layout-grid">
        <aside className="panel left-panel">
          <section>
            <h2>Targets</h2>
            <label className="toggle-line">
              <input type="checkbox" checked={allHosts} onChange={(event) => setAllHosts(event.target.checked)} />
              all hosts
            </label>
            <div className="host-list">
              {hosts.length === 0 ? (
                <p className="muted">No hosts yet.</p>
              ) : (
                hosts.map((host) => (
                  <label key={host.id} className="host-chip">
                    <input
                      type="checkbox"
                      disabled={allHosts}
                      checked={allHosts || selectedHostIDs.includes(host.id)}
                      onChange={() => toggleHostSelection(host.id)}
                    />
                    <span>
                      <strong>{host.name}</strong>
                      <small>
                        {host.user ? `${host.user}@` : ""}
                        {host.host}:{host.port}
                      </small>
                    </span>
                  </label>
                ))
              )}
            </div>
          </section>

          <section>
            <h2>Runtime</h2>
            <label>
              runtime
              <select value={selectedRuntime} onChange={(event) => setSelectedRuntime(event.target.value)}>
                {runtimes.map((runtime) => (
                  <option key={runtime.name} value={runtime.name}>
                    {runtime.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              mode
              <select value={runMode} onChange={(event) => setRunMode(event.target.value as "exec" | "resume" | "review")}> 
                <option value="exec">exec</option>
                <option value="resume">resume</option>
                <option value="review">review</option>
              </select>
            </label>
            <label>
              model
              <input value={runModel} onChange={(event) => setRunModel(event.target.value)} placeholder="optional" />
            </label>
            <label>
              sandbox
              <select
                value={runSandbox}
                onChange={(event) =>
                  setRunSandbox(event.target.value as "" | "read-only" | "workspace-write" | "danger-full-access")
                }
              >
                <option value="">default</option>
                <option value="read-only">read-only</option>
                <option value="workspace-write">workspace-write</option>
                <option value="danger-full-access">danger-full-access</option>
              </select>
            </label>
            <label className="toggle-line">
              <input type="checkbox" checked={runAsyncMode} onChange={(event) => setRunAsyncMode(event.target.checked)} />
              async job mode
            </label>
          </section>

          <section>
            <h2>Overview</h2>
            <ul className="mono-list">
              <li>hosts={hosts.length}</li>
              <li>selected={selectedHostCount}</li>
              <li>jobs={jobs.length}</li>
              <li>runs={runs.length}</li>
              <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
            </ul>
          </section>
        </aside>

        <main className="panel center-panel">
          <div className="timeline" aria-live="polite">
            {timeline.length === 0 ? (
              <article className="entry entry-system">
                <h3>Workspace Ready</h3>
                <p>Send a prompt to execute against selected hosts.</p>
              </article>
            ) : (
              timeline.map((entry) => (
                <article key={entry.id} className={`entry entry-${entry.kind} ${entry.state ? `entry-${entry.state}` : ""}`}>
                  <div className="entry-head">
                    <h3>{entry.title}</h3>
                    <time>{formatShortTime(entry.createdAt)}</time>
                  </div>
                  <pre>{entry.body}</pre>
                </article>
              ))
            )}
            <div ref={timelineBottomRef} />
          </div>

          <form className="composer" onSubmit={onSendPrompt}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="Type your instruction. Ctrl/Cmd + Enter to send."
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void onSendPrompt(event as unknown as FormEvent<HTMLFormElement>);
                }
              }}
            />
            <div className="composer-row">
              <input value={workdir} onChange={(event) => setWorkdir(event.target.value)} placeholder="workdir override (optional)" />
              <input value={fanoutValue} onChange={(event) => setFanoutValue(event.target.value)} placeholder="fanout" />
              <input value={maxOutputKB} onChange={(event) => setMaxOutputKB(event.target.value)} placeholder="max output KB" />
              <button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Running..." : "Send"}
              </button>
            </div>
          </form>
        </main>

        <aside className="panel right-panel">
          <section>
            <h2>Active Job</h2>
            {activeJob ? (
              <div className="job-card">
                <p>
                  <strong>{activeJob.id}</strong>
                </p>
                <p>
                  status={activeJob.status} runtime={activeJob.runtime}
                </p>
                <p>
                  total={activeJob.total_hosts ?? 0} ok={activeJob.succeeded_hosts ?? 0} failed={activeJob.failed_hosts ?? 0}
                </p>
                <p>http={activeJob.result_status ?? "n/a"}</p>
                {activeJob.error ? <p className="error-text">{activeJob.error}</p> : null}
              </div>
            ) : (
              <p className="muted">No active async job.</p>
            )}
          </section>

          <section>
            <h2>Recent Jobs</h2>
            {jobs.length === 0 ? (
              <p className="muted">No jobs yet.</p>
            ) : (
              <ul className="job-list">
                {jobs.slice(0, 8).map((job) => (
                  <li key={job.id}>
                    <button
                      className="ghost"
                      onClick={() => {
                        setActiveJobID(job.id);
                        setActiveJob(job);
                      }}
                    >
                      {job.id}
                    </button>
                    <span>{job.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Add Host</h2>
            <form className="host-form" onSubmit={onAddHost}>
              <input
                placeholder="name"
                value={hostForm.name}
                onChange={(event) => setHostForm((prev) => ({ ...prev, name: event.target.value }))}
              />
              <input
                placeholder="host"
                value={hostForm.host}
                onChange={(event) => setHostForm((prev) => ({ ...prev, host: event.target.value }))}
              />
              <input
                placeholder="user"
                value={hostForm.user}
                onChange={(event) => setHostForm((prev) => ({ ...prev, user: event.target.value }))}
              />
              <input
                placeholder="workspace"
                value={hostForm.workspace}
                onChange={(event) => setHostForm((prev) => ({ ...prev, workspace: event.target.value }))}
              />
              <button type="submit" disabled={addingHost}>
                {addingHost ? "Saving..." : "Save Host"}
              </button>
            </form>
          </section>
        </aside>
      </div>
    </div>
  );
}
