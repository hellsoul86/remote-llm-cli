import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  API_BASE,
  cancelRunJob,
  deleteHost,
  enqueueRunJob,
  getMetrics,
  getRunJob,
  healthz,
  listAudit,
  listHosts,
  listRunJobs,
  listRuns,
  listRuntimes,
  probeHost,
  runFanout,
  upsertHost,
  type Host,
  type RunJobRecord,
  type RunRequest,
  type RunResponse
} from "./api";
import { useOpsDomain } from "./domains/ops";
import { useSessionDomain } from "./domains/session";

const TOKEN_KEY = "remote_llm_access_key";

type AuthPhase = "checking" | "locked" | "ready";
type AppMode = "session" | "ops";

type QuickCommand = {
  label: string;
  template: string;
};

const QUICK_COMMANDS: QuickCommand[] = [
  { label: "/status", template: "report controller status, queue depth, and active jobs" },
  { label: "/hosts", template: "list all configured hosts with connectivity summary" },
  { label: "/jobs", template: "summarize last 10 jobs and failures with hints" },
  { label: "/sync", template: "check workspace sync readiness and list next safe sync actions" }
];

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

function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function statusTone(status: string): "ok" | "warn" | "err" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "canceled") return "err";
  return "warn";
}

function modeFromHash(hash: string): AppMode {
  return hash === "#/ops" ? "ops" : "session";
}

function modeToHash(mode: AppMode): string {
  return mode === "ops" ? "#/ops" : "#/session";
}

export function App() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState<string>(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [authError, setAuthError] = useState("");
  const [appMode, setAppMode] = useState<AppMode>(() =>
    typeof window === "undefined" ? "session" : modeFromHash(window.location.hash)
  );

  const ops = useOpsDomain();
  const session = useSessionDomain();

  const {
    health,
    setHealth,
    hosts,
    setHosts,
    runtimes,
    setRuntimes,
    jobs,
    setJobs,
    runs,
    setRuns,
    auditEvents,
    setAuditEvents,
    metrics,
    setMetrics,
    selectedRuntime,
    setSelectedRuntime,
    allHosts,
    setAllHosts,
    selectedHostIDs,
    setSelectedHostIDs,
    runMode,
    setRunMode,
    runModel,
    setRunModel,
    runSandbox,
    setRunSandbox,
    runAsyncMode,
    setRunAsyncMode,
    workdir,
    setWorkdir,
    fanoutValue,
    setFanoutValue,
    maxOutputKB,
    setMaxOutputKB,
    isSubmitting,
    setIsSubmitting,
    isRefreshing,
    setIsRefreshing,
    activeJobID,
    setActiveJobID,
    activeJob,
    setActiveJob,
    hostForm,
    setHostForm,
    hostFilter,
    setHostFilter,
    editingHostID,
    setEditingHostID,
    addingHost,
    setAddingHost,
    opsHostBusyID,
    setOpsHostBusyID,
    opsNotice,
    setOpsNotice,
    opsJobStatusFilter,
    setOpsJobStatusFilter,
    opsJobTypeFilter,
    setOpsJobTypeFilter,
    opsRunStatusFilter,
    setOpsRunStatusFilter,
    opsAuditMethodFilter,
    setOpsAuditMethodFilter,
    opsAuditStatusFilter,
    setOpsAuditStatusFilter,
    resetOpsDomain
  } = ops;

  const {
    threads,
    activeThreadID,
    setActiveThreadID,
    threadRenameDraft,
    setThreadRenameDraft,
    activeJobThreadID,
    setActiveJobThreadID,
    completedJobsRef,
    activeThread,
    activeTimeline,
    activeDraft,
    updateThreadDraft,
    addTimelineEntry,
    createThread,
    renameThread,
    switchThreadByOffset,
    resetSessionDomain
  } = session;

  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);

  const activeRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.name === selectedRuntime) ?? runtimes[0] ?? null,
    [runtimes, selectedRuntime]
  );
  const selectedHostCount = allHosts ? hosts.length : selectedHostIDs.length;

  const activeProgress = useMemo(() => {
    if (!activeJob) return 0;
    const total = activeJob.total_hosts ?? 0;
    if (total <= 0) return isJobActive(activeJob) ? 0 : 100;
    const done = (activeJob.succeeded_hosts ?? 0) + (activeJob.failed_hosts ?? 0);
    if (!isJobActive(activeJob)) return 100;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }, [activeJob]);

  const filteredOpsJobs = useMemo(() => {
    const byStatus = opsJobStatusFilter === "all" ? jobs : jobs.filter((job) => job.status === opsJobStatusFilter);
    if (opsJobTypeFilter === "all") return byStatus;
    return byStatus.filter((job) => job.type === opsJobTypeFilter);
  }, [jobs, opsJobStatusFilter, opsJobTypeFilter]);

  const filteredHosts = useMemo(() => {
    const query = hostFilter.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => {
      const text = `${host.name} ${host.host} ${host.user} ${host.workspace ?? ""} ${host.connection_mode ?? "ssh"}`.toLowerCase();
      return text.includes(query);
    });
  }, [hosts, hostFilter]);

  const filteredOpsRuns = useMemo(() => {
    if (opsRunStatusFilter === "all") return runs;
    if (opsRunStatusFilter === "ok") return runs.filter((run) => run.status_code < 400);
    return runs.filter((run) => run.status_code >= 400);
  }, [runs, opsRunStatusFilter]);

  const filteredAuditEvents = useMemo(() => {
    return auditEvents.filter((evt) => {
      if (opsAuditMethodFilter !== "all" && evt.method !== opsAuditMethodFilter) return false;
      if (opsAuditStatusFilter === "2xx" && (evt.status_code < 200 || evt.status_code >= 300)) return false;
      if (opsAuditStatusFilter === "4xx" && (evt.status_code < 400 || evt.status_code >= 500)) return false;
      if (opsAuditStatusFilter === "5xx" && (evt.status_code < 500 || evt.status_code >= 600)) return false;
      return true;
    });
  }, [auditEvents, opsAuditMethodFilter, opsAuditStatusFilter]);
  const healthIsError = health.startsWith("error");
  const opsNoticeIsError = /fail|error|degraded/i.test(opsNotice);
  const syncLabel = isRefreshing ? "syncing" : "live";

  function createThreadAndFocus() {
    createThread();
    promptInputRef.current?.focus();
  }

  function applyQuickCommand(command: QuickCommand) {
    if (!activeThread) return;
    const nextDraft = activeThread.draft.trim() ? `${activeThread.draft}\n${command.template}` : command.template;
    updateThreadDraft(activeThread.id, nextDraft);
    promptInputRef.current?.focus();
  }

  async function loadWorkspace(authToken: string, emitConnectedNote: boolean) {
    setIsRefreshing(true);
    try {
      const [healthBody, nextHosts, nextRuntimes, nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        listAudit(authToken, 80),
        getMetrics(authToken)
      ]);

      setHealth(`ok ${healthBody.timestamp}`);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setAuditEvents(nextAudit);
      setMetrics(nextMetrics);

      setSelectedHostIDs((prev) => prev.filter((id) => nextHosts.some((host) => host.id === id)));
      if (!nextRuntimes.some((runtime) => runtime.name === selectedRuntime)) {
        setSelectedRuntime(nextRuntimes[0]?.name ?? "codex");
      }

      const running = nextJobs.find((job) => isJobActive(job));
      if (running) {
        setActiveJobID(running.id);
        setActiveJob(running);
      } else {
        setActiveJobID("");
        setActiveJob(null);
      }

      if (emitConnectedNote) {
        addTimelineEntry(
          {
            kind: "system",
            state: "success",
            title: "Connected",
            body: `Connected. hosts=${nextHosts.length} runtimes=${nextRuntimes.length} queue_depth=${nextMetrics.queue.depth}`
          },
          activeThreadID
        );
      }
    } catch (error) {
      setHealth(`error: ${String(error)}`);
      if (emitConnectedNote) {
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Connection Failed",
            body: String(error)
          },
          activeThreadID
        );
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
    if (typeof window === "undefined") return;
    const syncFromHash = () => {
      setAppMode(modeFromHash(window.location.hash));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
    };
  }, []);

  useEffect(() => {
    timelineBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeTimeline.length, activeThreadID]);

  useEffect(() => {
    if (authPhase !== "ready") return;

    const handleGlobalKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        promptInputRef.current?.focus();
        return;
      }

      if (appMode !== "session") return;

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createThreadAndFocus();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "ArrowUp" || event.key === "[")) {
        event.preventDefault();
        switchThreadByOffset(-1);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "ArrowDown" || event.key === "]")) {
        event.preventDefault();
        switchThreadByOffset(1);
      }
    };

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  }, [authPhase, appMode, threads, activeThreadID]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim() || !activeJobID) return;

    let canceled = false;
    const pollIntervalMs = appMode === "session" ? 1800 : 3000;
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

          const targetThreadID = activeJobThreadID || activeThreadID;
          if (!completedJobsRef.current.has(job.id)) {
            completedJobsRef.current.add(job.id);
            if (isRunResponsePayload(job.response)) {
              addTimelineEntry(
                {
                  kind: "assistant",
                  state: job.status === "succeeded" ? "success" : "error",
                  title: `Job ${job.id} ${job.status}`,
                  body: summarizeRunResponse(job.response)
                },
                targetThreadID
              );
            } else {
              addTimelineEntry(
                {
                  kind: "assistant",
                  state: job.status === "succeeded" ? "success" : "error",
                  title: `Job ${job.id} ${job.status}`,
                  body: job.error ? String(job.error) : `runtime=${job.runtime} status=${job.status}`
                },
                targetThreadID
              );
            }
          }

          const [nextRuns, nextAudit, refreshedMetrics] = await Promise.all([listRuns(token, 20), listAudit(token, 80), getMetrics(token)]);
          if (canceled) return;
          setRuns(nextRuns);
          setAuditEvents(nextAudit);
          setMetrics(refreshedMetrics);
          setActiveJobThreadID(activeThreadID);
        }
      } catch (error) {
        if (canceled) return;
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Job Poll Failed",
            body: String(error)
          },
          activeJobThreadID || activeThreadID
        );
        setActiveJobID("");
        setIsSubmitting(false);
      }
    }, pollIntervalMs);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [authPhase, token, activeJobID, activeJobThreadID, activeThreadID, appMode]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim() || appMode !== "ops") return;

    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(token, 20),
          listRuns(token, 20),
          listAudit(token, 80),
          getMetrics(token)
        ]);
        if (canceled) return;
        setJobs(nextJobs);
        setRuns(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);

        if (!activeJobID) {
          const running = nextJobs.find((job) => isJobActive(job));
          if (running) {
            setActiveJobID(running.id);
            setActiveJob(running);
          }
        }
      } catch {
        if (canceled) return;
      }
    }, 5000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [authPhase, token, appMode, activeJobID]);

  async function onSubmitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await unlockWorkspace(tokenInput);
  }

  function switchMode(nextMode: AppMode) {
    setAppMode(nextMode);
    if (typeof window !== "undefined") {
      const nextHash = modeToHash(nextMode);
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    }
  }

  function onLogout() {
    localStorage.removeItem(TOKEN_KEY);
    resetOpsDomain();
    resetSessionDomain();
    setToken("");
    setTokenInput("");
    setAuthError("");
    setAuthPhase("locked");
    switchMode("session");
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
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;

    const trimmedPrompt = activeThread.draft.trim();
    if (!trimmedPrompt) {
      addTimelineEntry({ kind: "system", state: "error", title: "Prompt Missing", body: "Prompt is required." }, activeThread.id);
      return;
    }

    if (!allHosts && selectedHostIDs.length === 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Target Host",
          body: "Select at least one host or switch to all-host mode."
        },
        activeThread.id
      );
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

    addTimelineEntry(
      {
        kind: "user",
        title: `Run ${request.runtime}`,
        body: `${trimmedPrompt}\n\nmode=${runMode} async=${String(runAsyncMode)} hosts=${allHosts ? "all" : selectedHostIDs.join(",")}`
      },
      activeThread.id
    );

    setIsSubmitting(true);
    try {
      if (runAsyncMode) {
        const { body } = await enqueueRunJob(token, request);
        setActiveJobID(body.job.id);
        setActiveJobThreadID(activeThread.id);
        setActiveJob(body.job);
        setJobs((prev) => [body.job, ...prev.filter((job) => job.id !== body.job.id)]);
        addTimelineEntry(
          {
            kind: "system",
            state: "running",
            title: "Job Queued",
            body: `Job ${body.job.id} accepted. status=${body.job.status}`
          },
          activeThread.id
        );
      } else {
        const { status, body } = await runFanout(token, request);
        addTimelineEntry(
          {
            kind: "assistant",
            state: status >= 400 ? "error" : "success",
            title: `Run Finished (HTTP ${status})`,
            body: summarizeRunResponse(body)
          },
          activeThread.id
        );

        const [nextRuns, nextJobs, nextAudit, nextMetrics] = await Promise.all([
          listRuns(token, 20),
          listRunJobs(token, 20),
          listAudit(token, 80),
          getMetrics(token)
        ]);
        setRuns(nextRuns);
        setJobs(nextJobs);
        setAuditEvents(nextAudit);
        setMetrics(nextMetrics);
        setIsSubmitting(false);
      }
    } catch (error) {
      addTimelineEntry({ kind: "system", state: "error", title: "Run Failed", body: String(error) }, activeThread.id);
      setIsSubmitting(false);
    }
  }

  async function onAddHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;

    const mode = hostForm.connectionMode ?? "ssh";
    if (!hostForm.name.trim() || (mode === "ssh" && !hostForm.host.trim())) {
      const validationMessage = mode === "ssh" ? "name and host are required for ssh mode." : "name is required.";
      addTimelineEntry({ kind: "system", state: "error", title: "Host Validation", body: validationMessage });
      return;
    }

    const hostName = hostForm.name.trim();
    const editing = editingHostID;

    setAddingHost(true);
    try {
      await upsertHost(token, {
        id: editing || undefined,
        name: hostName,
        connection_mode: mode,
        host: hostForm.host.trim() || undefined,
        user: hostForm.user.trim() || undefined,
        workspace: hostForm.workspace.trim() || undefined
      });
      setHostForm({ name: "", connectionMode: "ssh", host: "", user: "", workspace: "" });
      setEditingHostID("");
      await loadWorkspace(token, false);
      addTimelineEntry({
        kind: "system",
        state: "success",
        title: editing ? "Host Updated" : "Host Saved",
        body: `${editing ? "Updated" : "Saved"} host ${hostName}.`
      });
      setOpsNotice(`${editing ? "Updated" : "Saved"} host ${hostName}.`);
    } catch (error) {
      addTimelineEntry({ kind: "system", state: "error", title: "Host Save Failed", body: String(error) });
    } finally {
      setAddingHost(false);
    }
  }

  function onStartEditHost(host: Host) {
    setEditingHostID(host.id);
    setHostForm({
      name: host.name,
      connectionMode: host.connection_mode === "local" ? "local" : "ssh",
      host: host.host,
      user: host.user ?? "",
      workspace: host.workspace ?? ""
    });
    setOpsNotice(`Editing host ${host.name}.`);
  }

  function onCancelHostEdit() {
    setEditingHostID("");
    setHostForm({ name: "", connectionMode: "ssh", host: "", user: "", workspace: "" });
    setOpsNotice("Canceled host edit.");
  }

  async function onProbeHost(host: Host) {
    if (authPhase !== "ready" || !token.trim()) return;
    setOpsHostBusyID(host.id);
    setOpsNotice(`Probing ${host.name}...`);
    try {
      const result = await probeHost(token, host.id, { preflight: true });
      const ssh = result.ssh?.ok ? "ok" : "fail";
      const codex = result.codex?.ok ? "ok" : "fail";
      const login = result.codex_login?.ok ? "ok" : "fail";
      const sshErr = result.ssh?.error ? ` ssh_error=${result.ssh.error}` : "";
      const codexErr = result.codex?.error ? ` codex_error=${result.codex.error}` : "";
      const loginErr = result.codex_login?.error ? ` login_error=${result.codex_login.error}` : "";
      setOpsNotice(`Probe ${host.name}: ssh=${ssh} codex=${codex} login=${login}${sshErr}${codexErr}${loginErr}`);
    } catch (error) {
      setOpsNotice(`Probe failed for ${host.name}: ${String(error)}`);
    } finally {
      setOpsHostBusyID("");
    }
  }

  async function onDeleteHost(host: Host) {
    if (authPhase !== "ready" || !token.trim()) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Delete host '${host.name}'?`);
      if (!confirmed) return;
    }

    setOpsHostBusyID(host.id);
    try {
      await deleteHost(token, host.id);
      setSelectedHostIDs((prev) => prev.filter((id) => id !== host.id));
      if (editingHostID === host.id) {
        onCancelHostEdit();
      }
      await loadWorkspace(token, false);
      setOpsNotice(`Deleted host ${host.name}.`);
    } catch (error) {
      setOpsNotice(`Delete failed for ${host.name}: ${String(error)}`);
    } finally {
      setOpsHostBusyID("");
    }
  }

  async function onCancelJob(job: RunJobRecord) {
    if (authPhase !== "ready" || !token.trim()) return;
    if (!isJobActive(job)) return;
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(`Cancel job '${job.id}'?`);
      if (!confirmed) return;
    }
    try {
      await cancelRunJob(token, job.id);
      setOpsNotice(`Cancel requested for ${job.id}.`);
      await loadWorkspace(token, false);
    } catch (error) {
      setOpsNotice(`Cancel failed for ${job.id}: ${String(error)}`);
    }
  }

  function onRenameActiveThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThread) return;
    renameThread(activeThread.id, threadRenameDraft);
  }

  if (authPhase !== "ready") {
    return (
      <div className="gate-shell">
        <div className="gate-noise" />
        <section className="gate-card">
          <p className="gate-eyebrow">remote-llm workspace</p>
          <h1>Token Required</h1>
          <p className="gate-copy">Use your access token to unlock the operator console. No token means no workspace access.</p>
          <form onSubmit={onSubmitToken} className="gate-form">
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
          {authError ? <p className="gate-error">{authError}</p> : null}
          <p className="gate-hint">API base: {API_BASE || "not configured"}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <header className="app-topbar">
        <div className="topbar-title">
          <p className="topbar-eyebrow">remote-llm workspace</p>
          <h1>Codex Control App</h1>
        </div>
        <div className="topbar-controls">
          <div className="mode-switch">
            <button type="button" className={appMode === "session" ? "mode-btn active" : "mode-btn"} onClick={() => switchMode("session")}>
              Session
            </button>
            <button type="button" className={appMode === "ops" ? "mode-btn active" : "mode-btn"} onClick={() => switchMode("ops")}>
              Ops
            </button>
          </div>
          <span className={`sync-pill ${isRefreshing ? "busy" : healthIsError ? "error" : "ok"}`}>{syncLabel}</span>
          <button onClick={() => void onRefreshWorkspace()} disabled={isRefreshing}>
            {isRefreshing ? "Syncing..." : "Sync"}
          </button>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      {healthIsError ? <section className="workspace-alert">Controller state degraded: {health}</section> : null}

      {appMode === "session" ? (
        <div className="session-stage">
          <main className="chat-pane">
            <header className="chat-head">
              <div>
                <p className="pane-eyebrow">focused session</p>
                <h1>{activeRuntime?.name ?? "codex"} conversation workspace</h1>
              </div>
              <p className={`chat-health ${healthIsError ? "is-error" : ""}`}>health: {health}</p>
            </header>

            <section className="thread-bar">
              <div className="thread-list">
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-chip ${thread.id === activeThreadID ? "active" : ""}`}
                    onClick={() => setActiveThreadID(thread.id)}
                    title={`${thread.title} (${thread.timeline.length} messages)`}
                  >
                    <span>{thread.title}</span>
                    <small>{thread.timeline.length}</small>
                  </button>
                ))}
              </div>
              <button type="button" className="ghost new-thread" onClick={createThreadAndFocus}>
                New Thread
              </button>
            </section>

            <section className="timeline" aria-live="polite">
              {activeTimeline.length === 0 ? (
                <article className="message message-system">
                  <div className="message-title-row">
                    <h4>{isRefreshing ? "Sync In Progress" : "Workspace Ready"}</h4>
                  </div>
                  <pre>
                    {isRefreshing
                      ? "Loading remote state and runtime capability snapshot..."
                      : "Send your first instruction to start a distributed codex run."}
                  </pre>
                </article>
              ) : (
                activeTimeline.map((entry) => (
                  <article key={entry.id} className={`message message-${entry.kind} ${entry.state ? `message-${entry.state}` : ""}`}>
                    <div className="message-title-row">
                      <h4>{entry.title}</h4>
                      <time>{formatClock(entry.createdAt)}</time>
                    </div>
                    <pre>{entry.body}</pre>
                  </article>
                ))
              )}
              <div ref={timelineBottomRef} />
            </section>

            <form ref={composerFormRef} className="composer" onSubmit={onSendPrompt}>
              <div className="session-strip">
                <span>runtime={activeRuntime?.name ?? selectedRuntime}</span>
                <span>mode={runMode}</span>
                <span>hosts={allHosts ? "all" : selectedHostIDs.length}</span>
                <span>async={String(runAsyncMode)}</span>
              </div>

              <div className="quick-strip">
                {QUICK_COMMANDS.map((command) => (
                  <button key={command.label} type="button" className="quick-chip ghost" onClick={() => applyQuickCommand(command)}>
                    {command.label}
                  </button>
                ))}
                <span className="shortcut-hint">Ctrl/Cmd+K focus, Ctrl/Cmd+Shift+N new thread</span>
              </div>

              <textarea
                ref={promptInputRef}
                value={activeDraft}
                onChange={(event) => {
                  if (activeThread) {
                    updateThreadDraft(activeThread.id, event.target.value);
                  }
                }}
                rows={4}
                placeholder="Tell codex what to execute on selected hosts..."
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    composerFormRef.current?.requestSubmit();
                  }
                }}
              />

              <div className="composer-controls">
                <input value={workdir} onChange={(event) => setWorkdir(event.target.value)} placeholder="workdir override" />
                <input value={fanoutValue} onChange={(event) => setFanoutValue(event.target.value)} placeholder="fanout" />
                <input value={maxOutputKB} onChange={(event) => setMaxOutputKB(event.target.value)} placeholder="max output KB" />
                <button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Running..." : "Send"}
                </button>
              </div>
            </form>
          </main>

          <aside className="session-side">
            <section className="inspect-block focus-block">
              <h3>Session Context</h3>
              <ul className="metric-list metric-list-light">
                <li>thread={activeThread?.title ?? "-"}</li>
                <li>threads={threads.length}</li>
                <li>targets={selectedHostCount}</li>
                <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
              </ul>
              <form className="thread-rename-form" onSubmit={onRenameActiveThread}>
                <input
                  value={threadRenameDraft}
                  onChange={(event) => setThreadRenameDraft(event.target.value)}
                  placeholder="thread name"
                  maxLength={48}
                />
                <button type="submit">Rename</button>
              </form>
              <ul className="session-keymap">
                <li>Ctrl/Cmd + K: focus prompt</li>
                <li>Ctrl/Cmd + Shift + N: new thread</li>
                <li>Ctrl/Cmd + Shift + [ or ArrowUp: previous thread</li>
                <li>Ctrl/Cmd + Shift + ] or ArrowDown: next thread</li>
              </ul>
              <button type="button" className="ghost" onClick={() => switchMode("ops")}>
                Open Remote Ops
              </button>
            </section>

            <section className="inspect-block">
              <h3>Active Job</h3>
              {activeJob ? (
                <div className="job-card">
                  <div className="job-head">
                    <strong>{activeJob.id}</strong>
                    <span className={`tone-${statusTone(activeJob.status)}`}>{activeJob.status}</span>
                  </div>
                  <p>runtime={activeJob.runtime}</p>
                  <p>thread={activeJobThreadID}</p>
                  <p>queued={formatDateTime(activeJob.queued_at)}</p>
                  <div className="progress-track" aria-label="job progress">
                    <span style={{ width: `${activeProgress}%` }} />
                  </div>
                </div>
              ) : (
                <p className="pane-subtle-light">No active async job.</p>
              )}
            </section>

            <section className="inspect-block">
              <h3>Recent Jobs</h3>
              {jobs.length === 0 ? (
                <p className="pane-subtle-light">No jobs yet.</p>
              ) : (
                <ul className="history-list">
                  {jobs.slice(0, 6).map((job) => (
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
                      <span className={`tone-${statusTone(job.status)}`}>{job.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      ) : (
        <div className="ops-stage">
          <aside className="nav-pane">
            <header className="pane-head">
              <p className="pane-eyebrow">remote operations</p>
              <h2>Hosts and Runtime Control</h2>
              <p className="pane-subtle">health: {health}</p>
            </header>

            <section className="pane-block">
              <div className="pane-title-line">
                <h3>Targets</h3>
                <label className="switch-inline">
                  <input type="checkbox" checked={allHosts} onChange={(event) => setAllHosts(event.target.checked)} />
                  all
                </label>
              </div>
              <p className="pane-subtle">selected={selectedHostCount}</p>
              <label>
                filter
                <input
                  placeholder="name / host / user / workspace"
                  value={hostFilter}
                  onChange={(event) => setHostFilter(event.target.value)}
                />
              </label>
              <div className="target-list">
                {hosts.length === 0 ? (
                  <p className="pane-subtle">No hosts configured.</p>
                ) : filteredHosts.length === 0 ? (
                  <p className="pane-subtle">No hosts match filter.</p>
                ) : (
                  filteredHosts.map((host) => (
                    <div key={host.id} className="target-item">
                      <label className="target-checkline">
                        <input
                          type="checkbox"
                          disabled={allHosts}
                          checked={allHosts || selectedHostIDs.includes(host.id)}
                          onChange={() => toggleHostSelection(host.id)}
                        />
                        <span className="target-meta">
                          <strong>{host.name}</strong>
                          <small>
                            {host.user ? `${host.user}@` : ""}
                            {host.host}:{host.port}
                            {` mode=${host.connection_mode ?? "ssh"}`}
                          </small>
                        </span>
                      </label>
                      <div className="target-actions">
                        <button type="button" className="ghost" disabled={opsHostBusyID === host.id} onClick={() => void onProbeHost(host)}>
                          {opsHostBusyID === host.id ? "..." : "Probe"}
                        </button>
                        <button type="button" className="ghost" disabled={opsHostBusyID === host.id} onClick={() => onStartEditHost(host)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost danger-ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => void onDeleteHost(host)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="pane-block">
              <h3>Runtime</h3>
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
              <label className="switch-inline">
                <input type="checkbox" checked={runAsyncMode} onChange={(event) => setRunAsyncMode(event.target.checked)} />
                async queue
              </label>
            </section>

            <section className="pane-block">
              <h3>Queue Control</h3>
              <ul className="metric-list">
                <li>pending={metrics?.jobs.pending ?? "-"}</li>
                <li>running={metrics?.jobs.running ?? "-"}</li>
                <li>depth={metrics?.queue.depth ?? "-"}</li>
              </ul>
              <div className="ops-actions-row">
                <button type="button" className="ghost" onClick={() => void onRefreshWorkspace()} disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh Queue"}
                </button>
                <button
                  type="button"
                  className="ghost danger-ghost"
                  disabled={!activeJob || !isJobActive(activeJob)}
                  onClick={() => (activeJob ? void onCancelJob(activeJob) : undefined)}
                >
                  Cancel Active
                </button>
              </div>
            </section>

            <section className="pane-block">
              <h3>Overview</h3>
              <ul className="metric-list">
                <li>hosts={hosts.length}</li>
                <li>jobs={jobs.length}</li>
                <li>runs={runs.length}</li>
                <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
                <li>workers={metrics?.queue.workers_active ?? "-"}/{metrics?.queue.workers_total ?? "-"}</li>
                <li>threads={threads.length}</li>
              </ul>
            </section>

            {opsNotice ? (
              <section className={`pane-block ops-notice ${opsNoticeIsError ? "ops-notice-error" : ""}`}>
                <h3>Ops Notice</h3>
                <p>{opsNotice}</p>
              </section>
            ) : null}
          </aside>

          <aside className="inspect-pane">
            {isRefreshing ? (
              <section className="inspect-block">
                <h3>Loading</h3>
                <p className="pane-subtle-light">Refreshing hosts, queue, runs, and audit timeline...</p>
              </section>
            ) : null}

            <section className="inspect-block">
              <h3>Active Job</h3>
              {activeJob ? (
                <div className="job-card">
                  <div className="job-head">
                    <strong>{activeJob.id}</strong>
                    <span className={`tone-${statusTone(activeJob.status)}`}>{activeJob.status}</span>
                  </div>
                  <p>runtime={activeJob.runtime}</p>
                  <p>thread={activeJobThreadID}</p>
                  <p>queued={formatDateTime(activeJob.queued_at)}</p>
                  <p>
                    hosts total={activeJob.total_hosts ?? 0} ok={activeJob.succeeded_hosts ?? 0} failed={activeJob.failed_hosts ?? 0}
                  </p>
                  <div className="progress-track" aria-label="job progress">
                    <span style={{ width: `${activeProgress}%` }} />
                  </div>
                  <p>http={activeJob.result_status ?? "n/a"}</p>
                  {activeJob.error ? <p className="tone-err">{activeJob.error}</p> : null}
                </div>
              ) : (
                <p className="pane-subtle-light">No active async job.</p>
              )}
            </section>

            <section className="inspect-block">
              <h3>Recent Jobs</h3>
              <div className="ops-filter-row">
                <label>
                  status
                  <select
                    value={opsJobStatusFilter}
                    onChange={(event) =>
                      setOpsJobStatusFilter(
                        event.target.value as "all" | "pending" | "running" | "succeeded" | "failed" | "canceled"
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="pending">pending</option>
                    <option value="running">running</option>
                    <option value="succeeded">succeeded</option>
                    <option value="failed">failed</option>
                    <option value="canceled">canceled</option>
                  </select>
                </label>
                <label>
                  type
                  <select value={opsJobTypeFilter} onChange={(event) => setOpsJobTypeFilter(event.target.value as "all" | "run" | "sync")}>
                    <option value="all">all</option>
                    <option value="run">run</option>
                    <option value="sync">sync</option>
                  </select>
                </label>
              </div>
              {filteredOpsJobs.length === 0 ? (
                <p className="pane-subtle-light">No jobs yet.</p>
              ) : (
                <ul className="history-list">
                  {filteredOpsJobs.slice(0, 8).map((job) => (
                    <li key={job.id}>
                      <div className="history-item-main">
                        <button
                          className="ghost"
                          onClick={() => {
                            setActiveJobID(job.id);
                            setActiveJob(job);
                          }}
                        >
                          {job.id}
                        </button>
                        <span className={`tone-${statusTone(job.status)}`}>{job.status}</span>
                        <span>{job.type}</span>
                      </div>
                      <div className="history-item-actions">
                        {isJobActive(job) ? (
                          <button type="button" className="ghost danger-ghost" onClick={() => void onCancelJob(job)}>
                            Cancel
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>Recent Runs</h3>
              <div className="ops-filter-row">
                <label>
                  status
                  <select value={opsRunStatusFilter} onChange={(event) => setOpsRunStatusFilter(event.target.value as "all" | "ok" | "error")}>
                    <option value="all">all</option>
                    <option value="ok">ok</option>
                    <option value="error">error</option>
                  </select>
                </label>
              </div>
              {filteredOpsRuns.length === 0 ? (
                <p className="pane-subtle-light">No run results yet.</p>
              ) : (
                <ul className="history-list history-runs">
                  {filteredOpsRuns.slice(0, 8).map((run) => (
                    <li key={run.id}>
                      <span>{run.id}</span>
                      <span className={`tone-${run.status_code < 400 ? "ok" : "err"}`}>
                        {run.status_code < 400 ? "ok" : `http_${run.status_code}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>Audit Timeline</h3>
              <div className="ops-filter-row">
                <label>
                  method
                  <select
                    value={opsAuditMethodFilter}
                    onChange={(event) => setOpsAuditMethodFilter(event.target.value as "all" | "GET" | "POST" | "DELETE")}
                  >
                    <option value="all">all</option>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </label>
                <label>
                  status
                  <select
                    value={opsAuditStatusFilter}
                    onChange={(event) => setOpsAuditStatusFilter(event.target.value as "all" | "2xx" | "4xx" | "5xx")}
                  >
                    <option value="all">all</option>
                    <option value="2xx">2xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                  </select>
                </label>
              </div>
              {filteredAuditEvents.length === 0 ? (
                <p className="pane-subtle-light">No audit events with current filters.</p>
              ) : (
                <ul className="history-list">
                  {filteredAuditEvents.slice(0, 12).map((evt) => (
                    <li key={evt.id}>
                      <div className="history-item-main">
                        <span>{evt.action}</span>
                        <span>
                          {evt.method} {evt.path}
                        </span>
                      </div>
                      <span className={`tone-${evt.status_code < 400 ? "ok" : "err"}`}>{evt.status_code}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="inspect-block">
              <h3>{editingHostID ? "Edit Host" : "Add Host"}</h3>
              <form className="host-form" onSubmit={onAddHost}>
                <input
                  placeholder="name"
                  value={hostForm.name}
                  onChange={(event) => setHostForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <label>
                  connection mode
                  <select
                    value={hostForm.connectionMode}
                    onChange={(event) => setHostForm((prev) => ({ ...prev, connectionMode: event.target.value as "ssh" | "local" }))}
                  >
                    <option value="ssh">ssh</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <input
                  placeholder={hostForm.connectionMode === "local" ? "host (optional for local mode)" : "host"}
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
                <div className="ops-actions-row">
                  <button type="submit" disabled={addingHost}>
                    {addingHost ? "Saving..." : editingHostID ? "Update Host" : "Save Host"}
                  </button>
                  {editingHostID ? (
                    <button type="button" className="ghost" onClick={onCancelHostEdit}>
                      Cancel Edit
                    </button>
                  ) : null}
                </div>
              </form>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}
