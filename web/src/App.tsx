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
  listRunJobEvents,
  listRunJobs,
  listRuns,
  listRuntimes,
  probeHost,
  runFanout,
  uploadImage,
  upsertHost,
  type Host,
  type RunJobEvent,
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

type SessionAlert = {
  id: string;
  threadID: string;
  title: string;
  body: string;
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

function summarizeJobEventLine(event: RunJobEvent): string {
  const host = event.host_name || event.host_id || "target";
  switch (event.type) {
    case "target.started":
      return `${host} started (attempt=${event.attempt ?? 1})`;
    case "target.done":
      return `${host} done status=${event.status ?? "unknown"} exit=${event.exit_code ?? "n/a"}${event.error ? ` error=${event.error}` : ""}`;
    case "job.cancel_requested":
      return "cancel requested";
    case "job.canceled":
      return "job canceled";
    case "job.failed":
      return event.error ? `job failed: ${event.error}` : "job failed";
    case "job.succeeded":
      return "job completed";
    default:
      return "";
  }
}

function clipStreamText(raw: string, maxChars = 3600): string {
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(raw.length - maxChars)}\n...[stream truncated for UI]...`;
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
    fanoutValue,
    setFanoutValue,
    maxOutputKB,
    setMaxOutputKB,
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
    workspaces,
    activeWorkspace,
    activeWorkspaceID,
    setActiveWorkspaceID,
    workspacePathDraft,
    setWorkspacePathDraft,
    workspaceAddDraft,
    setWorkspaceAddDraft,
    addWorkspace,
    updateActiveWorkspacePath,
    threads,
    activeThreadID,
    setActiveThreadID,
    activateThread,
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
    setThreadModel,
    setThreadSandbox,
    addThreadImagePath,
    removeThreadImagePath,
    setThreadJobState,
    setThreadUnread,
    runningThreadJobs,
    resetSessionDomain
  } = session;

  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification === "undefined" ? "denied" : Notification.permission
  );
  const [sessionAlerts, setSessionAlerts] = useState<SessionAlert[]>([]);
  const [submittingThreadID, setSubmittingThreadID] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState("");

  const timelineBottomRef = useRef<HTMLDivElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const jobEventCursorRef = useRef<Map<string, number>>(new Map());

  const activeRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.name === selectedRuntime) ?? runtimes[0] ?? null,
    [runtimes, selectedRuntime]
  );
  const selectedHostCount = allHosts ? hosts.length : selectedHostIDs.length;
  const threadWorkspaceMap = useMemo(() => {
    const out = new Map<string, string>();
    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        out.set(thread.id, workspace.id);
      }
    }
    return out;
  }, [workspaces]);
  const threadTitleMap = useMemo(() => {
    const out = new Map<string, string>();
    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        out.set(thread.id, thread.title);
      }
    }
    return out;
  }, [workspaces]);
  const activeThreadBusy = Boolean(activeThread?.activeJobID) || (activeThread ? submittingThreadID === activeThread.id : false);

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

  function notifySessionDone(title: string, body: string) {
    if (typeof Notification === "undefined") return;
    if (notificationPermission !== "granted") return;
    try {
      const note = new Notification(title, { body, silent: false });
      window.setTimeout(() => note.close(), 6000);
    } catch {
      // Notification failures are non-fatal for session completion flow.
    }
  }

  function pushSessionAlert(alert: Omit<SessionAlert, "id">) {
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: SessionAlert = { id, ...alert };
    setSessionAlerts((prev) => [...prev, next]);
    window.setTimeout(() => {
      setSessionAlerts((prev) => prev.filter((item) => item.id !== id));
    }, 7000);
  }

  function openSessionFromAlert(alert: SessionAlert) {
    if (threadWorkspaceMap.has(alert.threadID)) {
      activateThread(alert.threadID);
      switchMode("session");
    }
    setSessionAlerts((prev) => prev.filter((item) => item.id !== alert.id));
  }

  async function onEnableNotifications() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("denied");
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
  }

  async function ensureLocalCodexHost(authToken: string, currentHosts: Host[]): Promise<Host[]> {
    if (currentHosts.some((host) => host.connection_mode === "local")) {
      return currentHosts;
    }
    await upsertHost(authToken, {
      name: "local-default",
      connection_mode: "local",
      host: "localhost",
      workspace: activeWorkspace?.path?.trim() || "/home/ecs-user"
    });
    return listHosts(authToken);
  }

  async function loadWorkspace(authToken: string, emitConnectedNote: boolean) {
    setIsRefreshing(true);
    try {
      const [healthBody, fetchedHosts, nextRuntimes, nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        listAudit(authToken, 80),
        getMetrics(authToken)
      ]);
      const nextHosts = await ensureLocalCodexHost(authToken, fetchedHosts);

      setHealth(`ok ${healthBody.timestamp}`);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setAuditEvents(nextAudit);
      setMetrics(nextMetrics);

      const localHost = nextHosts.find((host) => host.connection_mode === "local");
      if (localHost) {
        setAllHosts(false);
        setSelectedHostIDs([localHost.id]);
      } else {
        setSelectedHostIDs((prev) => {
          const nextSelected = prev.filter((id) => nextHosts.some((host) => host.id === id));
          if (nextSelected.length > 0) return nextSelected;
          if (nextHosts.length > 0) return [nextHosts[0].id];
          return [];
        });
      }
      const codexRuntime = nextRuntimes.find((runtime) => runtime.name === "codex");
      if (codexRuntime) {
        setSelectedRuntime("codex");
      } else if (!nextRuntimes.some((runtime) => runtime.name === selectedRuntime)) {
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
      for (const job of nextJobs) {
        if (!isJobActive(job)) continue;
        if (!jobEventCursorRef.current.has(job.id)) {
          jobEventCursorRef.current.set(job.id, 0);
        }
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
    if (appMode !== "session" || authPhase !== "ready" || !token.trim()) return;
    if (!activeThread?.activeJobID) {
      setActiveJobID("");
      setActiveJob(null);
      return;
    }
    void getRunJob(token, activeThread.activeJobID)
      .then((job) => {
        setActiveJobID(job.id);
        setActiveJob(job);
      })
      .catch(() => {
        setActiveJobID("");
        setActiveJob(null);
      });
  }, [appMode, authPhase, token, activeThread?.id, activeThread?.activeJobID]);

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
    if (authPhase !== "ready" || !token.trim()) return;
    if (runningThreadJobs.length === 0) return;

    let canceled = false;
    const poll = async () => {
      try {
        const jobResults = await Promise.all(
          runningThreadJobs.map(async (item) => {
            try {
              const after = jobEventCursorRef.current.get(item.jobID) ?? 0;
              const [job, eventFeed] = await Promise.all([
                getRunJob(token, item.jobID),
                listRunJobEvents(token, item.jobID, after, 240).catch(() => ({ events: [] as RunJobEvent[], next_after: after }))
              ]);
              return { item, job, error: "", events: eventFeed.events, nextAfter: eventFeed.next_after };
            } catch (error) {
              return {
                item,
                job: null as RunJobRecord | null,
                error: String(error),
                events: [] as RunJobEvent[],
                nextAfter: jobEventCursorRef.current.get(item.jobID) ?? 0
              };
            }
          })
        );
        if (canceled) return;

        for (const result of jobResults) {
          const { item, job, error, events, nextAfter } = result;
          if (!job) {
            addTimelineEntry(
              {
                kind: "system",
                state: "error",
                title: "Job Poll Failed",
                body: error
              },
              item.threadID
            );
            setThreadJobState(item.threadID, "", "failed");
            continue;
          }
          jobEventCursorRef.current.set(item.jobID, nextAfter);

          const progressLines: string[] = [];
          let stdoutStream = "";
          let stderrStream = "";
          for (const event of events) {
            const line = summarizeJobEventLine(event);
            if (line) progressLines.push(line);
            if (event.type === "target.stdout" && typeof event.chunk === "string") {
              stdoutStream += event.chunk;
            }
            if (event.type === "target.stderr" && typeof event.chunk === "string") {
              stderrStream += event.chunk;
            }
          }
          if (progressLines.length > 0) {
            addTimelineEntry(
              {
                kind: "system",
                state: "running",
                title: `Job ${item.jobID} progress`,
                body: progressLines.join("\n")
              },
              item.threadID
            );
          }
          if (stdoutStream.trim()) {
            addTimelineEntry(
              {
                kind: "assistant",
                state: "running",
                title: `Job ${item.jobID} stdout`,
                body: clipStreamText(stdoutStream)
              },
              item.threadID
            );
          }
          if (stderrStream.trim()) {
            addTimelineEntry(
              {
                kind: "system",
                state: "running",
                title: `Job ${item.jobID} stderr`,
                body: clipStreamText(stderrStream)
              },
              item.threadID
            );
          }

          if (item.threadID === activeThreadID) {
            setActiveJob(job);
            setActiveJobID(job.id);
          }

          if (isJobActive(job)) {
            setThreadJobState(item.threadID, job.id, "running");
            continue;
          }

          const terminalStatus =
            job.status === "succeeded" || job.status === "failed" || job.status === "canceled" ? job.status : "failed";
          setThreadJobState(item.threadID, "", terminalStatus);
          jobEventCursorRef.current.delete(item.jobID);
          if (item.threadID !== activeThreadID) {
            setThreadUnread(item.threadID, true);
          }

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
                item.threadID
              );
            } else {
              addTimelineEntry(
                {
                  kind: "assistant",
                  state: job.status === "succeeded" ? "success" : "error",
                  title: `Job ${job.id} ${job.status}`,
                  body: job.error ? String(job.error) : `runtime=${job.runtime} status=${job.status}`
                },
                item.threadID
              );
            }
            const sessionTitle = threadTitleMap.get(item.threadID) ?? "Session";
            notifySessionDone(`Codex ${job.status}`, `${sessionTitle}: ${job.id}`);
            pushSessionAlert({
              threadID: item.threadID,
              title: `${sessionTitle} finished`,
              body: `job=${job.id} status=${job.status}`
            });
          }
        }

        const [nextJobs, nextRuns, nextAudit, refreshedMetrics] = await Promise.all([
          listRunJobs(token, 20),
          listRuns(token, 20),
          listAudit(token, 80),
          getMetrics(token)
        ]);
        if (canceled) return;
        setJobs(nextJobs);
        setRuns(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(refreshedMetrics);
      } catch {
        if (canceled) return;
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2100);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [authPhase, token, runningThreadJobs, activeThreadID, threadTitleMap]);

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
    jobEventCursorRef.current.clear();
    setSubmittingThreadID("");
    setSessionAlerts([]);
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
    if (activeThread.activeJobID || submittingThreadID === activeThread.id) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Session Busy",
          body: "This session already has a running job. Switch to another session or wait for completion."
        },
        activeThread.id
      );
      return;
    }

    const trimmedPrompt = activeThread.draft.trim();
    if (!trimmedPrompt) {
      addTimelineEntry({ kind: "system", state: "error", title: "Prompt Missing", body: "Prompt is required." }, activeThread.id);
      return;
    }

    const localHostIDs = hosts.filter((host) => host.connection_mode === "local").map((host) => host.id);
    const targetHostIDs =
      selectedHostIDs.length > 0 ? selectedHostIDs : localHostIDs.length > 0 ? localHostIDs : hosts.length > 0 ? [hosts[0].id] : [];
    if (targetHostIDs.length === 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Target Host",
          body: "No local host found. Add a local host first."
        },
        activeThread.id
      );
      return;
    }

    const selectedHosts = hosts.filter((host) => targetHostIDs.includes(host.id));
    const hasNonLocalTarget = selectedHosts.some((host) => host.connection_mode !== "local");
    const safeImagePaths = hasNonLocalTarget ? [] : activeThread.imagePaths;
    if (hasNonLocalTarget && activeThread.imagePaths.length > 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Image Attachment Skipped",
          body: "Image attachments are only applied to local-mode targets."
        },
        activeThread.id
      );
    }

    const fanout = Math.max(1, Number.parseInt(fanoutValue, 10) || 1);
    const outputCap = Math.max(32, Number.parseInt(maxOutputKB, 10) || 256);
    const effectiveModel = activeThread.model.trim() || runModel.trim() || undefined;
    const effectiveSandbox = activeThread.sandbox || runSandbox || "workspace-write";
    const effectiveWorkdir = activeWorkspace?.path.trim() || undefined;

    const request: RunRequest = {
      runtime: activeRuntime?.name ?? selectedRuntime,
      prompt: trimmedPrompt,
      all_hosts: false,
      host_ids: targetHostIDs,
      workdir: effectiveWorkdir,
      fanout,
      max_output_kb: outputCap,
      codex:
        (activeRuntime?.name ?? selectedRuntime) === "codex"
          ? {
              mode: runMode,
              model: effectiveModel,
              sandbox: effectiveSandbox,
              images: safeImagePaths.length > 0 ? safeImagePaths : undefined,
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
        body: `${trimmedPrompt}\n\nmode=${runMode} async=${String(runAsyncMode)} hosts=${targetHostIDs.join(",")} workdir=${effectiveWorkdir ?? "-"} model=${effectiveModel ?? "-"} sandbox=${effectiveSandbox}`
      },
      activeThread.id
    );

    setSubmittingThreadID(activeThread.id);
    try {
      if (runAsyncMode) {
        const { body } = await enqueueRunJob(token, request);
        jobEventCursorRef.current.set(body.job.id, 0);
        setActiveJobID(body.job.id);
        setActiveJobThreadID(activeThread.id);
        setActiveJob(body.job);
        setThreadJobState(activeThread.id, body.job.id, "running");
        setJobs((prev) => [body.job, ...prev.filter((job) => job.id !== body.job.id)]);
        setSubmittingThreadID("");
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
        setThreadJobState(activeThread.id, "", status >= 400 ? "failed" : "succeeded");
        setSubmittingThreadID("");
      }
    } catch (error) {
      addTimelineEntry({ kind: "system", state: "error", title: "Run Failed", body: String(error) }, activeThread.id);
      setThreadJobState(activeThread.id, "", "failed");
      setSubmittingThreadID("");
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
      const related = runningThreadJobs.find((item) => item.jobID === job.id);
      if (related) {
        setThreadJobState(related.threadID, "", "canceled");
      }
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

  function onSaveWorkspacePath(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateActiveWorkspacePath(workspacePathDraft);
  }

  function onAddWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addWorkspace(workspaceAddDraft);
  }

  async function onUploadSessionImage(file: File) {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    setUploadingImage(true);
    setImageUploadError("");
    try {
      const uploaded = await uploadImage(token, file);
      addThreadImagePath(activeThread.id, uploaded.path);
    } catch (error) {
      setImageUploadError(String(error));
    } finally {
      setUploadingImage(false);
    }
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
          <aside className="session-side codex-sidebar">
            <section className="inspect-block focus-block">
              <h3>Directories</h3>
              <form className="thread-rename-form" onSubmit={onSaveWorkspacePath}>
                <input
                  value={workspacePathDraft}
                  onChange={(event) => setWorkspacePathDraft(event.target.value)}
                  placeholder="/absolute/workdir"
                />
                <button type="submit">Set Path</button>
              </form>
              <div className="thread-list workspace-list">
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    className={`thread-chip ${workspace.id === activeWorkspaceID ? "active" : ""}`}
                    onClick={() => {
                      setActiveWorkspaceID(workspace.id);
                      setWorkspacePathDraft(workspace.path);
                    }}
                    title={workspace.path}
                  >
                    <span>{workspace.path}</span>
                    <small>{workspace.sessions.length}</small>
                  </button>
                ))}
              </div>
              <form className="thread-rename-form" onSubmit={onAddWorkspace}>
                <input
                  value={workspaceAddDraft}
                  onChange={(event) => setWorkspaceAddDraft(event.target.value)}
                  placeholder="add another workdir"
                />
                <button type="submit">Add</button>
              </form>
            </section>

            <section className="inspect-block">
              <div className="pane-title-line">
                <h3>Sessions</h3>
                <button type="button" className="ghost new-thread" onClick={createThreadAndFocus}>
                  New
                </button>
              </div>
              <div className="thread-list workspace-list">
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`thread-chip ${thread.id === activeThreadID ? "active" : ""}`}
                    onClick={() => setActiveThreadID(thread.id)}
                    title={`${thread.title} (${thread.timeline.length} messages)`}
                  >
                    <span>{thread.activeJobID ? `● ${thread.title}` : thread.unreadDone ? `* ${thread.title}` : thread.title}</span>
                    <small>
                      {thread.activeJobID
                        ? "running"
                        : thread.unreadDone
                          ? "done"
                          : thread.lastJobStatus === "idle"
                            ? thread.timeline.length
                            : thread.lastJobStatus}
                    </small>
                  </button>
                ))}
              </div>
              <form className="thread-rename-form" onSubmit={onRenameActiveThread}>
                <input
                  value={threadRenameDraft}
                  onChange={(event) => setThreadRenameDraft(event.target.value)}
                  placeholder="session name"
                  maxLength={48}
                />
                <button type="submit">Rename</button>
              </form>
              <button type="button" className="ghost" onClick={() => void onEnableNotifications()}>
                Alerts: {notificationPermission}
              </button>
            </section>

            <section className="inspect-block">
              <h3>Session Context</h3>
              <ul className="metric-list metric-list-light">
                <li>workdir={activeWorkspace?.path ?? "-"}</li>
                <li>session={activeThread?.title ?? "-"}</li>
                <li>sessions={threads.length}</li>
                <li>targets={selectedHostCount}</li>
                <li>queue_depth={metrics?.queue.depth ?? "-"}</li>
              </ul>
              <ul className="session-keymap">
                <li>Ctrl/Cmd + K: focus prompt</li>
                <li>Ctrl/Cmd + Shift + N: new session</li>
                <li>Ctrl/Cmd + Shift + [ or ArrowUp: previous session</li>
                <li>Ctrl/Cmd + Shift + ] or ArrowDown: next session</li>
              </ul>
              <button type="button" className="ghost" onClick={() => switchMode("ops")}>
                Open Remote Ops
              </button>
            </section>
          </aside>

          <main className="chat-pane">
            <header className="chat-head">
              <div>
                <p className="pane-eyebrow">local-first codex session</p>
                <h1>{activeThread?.title ?? "Session"} · {activeWorkspace?.path ?? "/home/ecs-user"}</h1>
              </div>
              <p className={`chat-health ${healthIsError ? "is-error" : ""}`}>health: {health}</p>
            </header>

            <section className="timeline" aria-live="polite">
              {activeTimeline.length === 0 ? (
                <article className="message message-system">
                  <div className="message-title-row">
                    <h4>{isRefreshing ? "Sync In Progress" : "Workspace Ready"}</h4>
                  </div>
                  <pre>
                    {isRefreshing
                      ? "Loading local codex runtime and background session state..."
                      : "Start chatting with codex. Non-active sessions continue syncing in background."}
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
                <span>workdir={activeWorkspace?.path ?? "-"}</span>
                <span>async={String(runAsyncMode)}</span>
              </div>

              <div className="quick-strip">
                {QUICK_COMMANDS.map((command) => (
                  <button key={command.label} type="button" className="quick-chip ghost" onClick={() => applyQuickCommand(command)}>
                    {command.label}
                  </button>
                ))}
                <span className="shortcut-hint">Ctrl/Cmd+K focus, Ctrl/Cmd+Shift+N new session</span>
              </div>

              <div className="composer-controls">
                <select value={runMode} onChange={(event) => setRunMode(event.target.value as "exec" | "resume" | "review")}>
                  <option value="exec">exec</option>
                  <option value="resume">resume</option>
                  <option value="review">review</option>
                </select>
                <input
                  value={activeThread?.model ?? ""}
                  onChange={(event) => activeThread && setThreadModel(activeThread.id, event.target.value)}
                  placeholder="model"
                />
                <select
                  value={activeThread?.sandbox ?? "workspace-write"}
                  onChange={(event) =>
                    activeThread &&
                    setThreadSandbox(activeThread.id, event.target.value as "" | "read-only" | "workspace-write" | "danger-full-access")
                  }
                >
                  <option value="read-only">read-only</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
                <input value={fanoutValue} onChange={(event) => setFanoutValue(event.target.value)} placeholder="fanout" />
                <input value={maxOutputKB} onChange={(event) => setMaxOutputKB(event.target.value)} placeholder="max output KB" />
              </div>

              <div className="quick-strip">
                <label className="quick-chip ghost file-chip">
                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploadingImage}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      void onUploadSessionImage(file);
                      event.currentTarget.value = "";
                    }}
                  />
                  {uploadingImage ? "uploading..." : "Attach Image"}
                </label>
                {(activeThread?.imagePaths ?? []).map((imagePath) => (
                  <button
                    key={imagePath}
                    type="button"
                    className="quick-chip ghost"
                    onClick={() => activeThread && removeThreadImagePath(activeThread.id, imagePath)}
                  >
                    {imagePath.split("/").pop() ?? imagePath} ×
                  </button>
                ))}
                {imageUploadError ? <span className="shortcut-hint">{imageUploadError}</span> : null}
              </div>

              <textarea
                ref={promptInputRef}
                value={activeDraft}
                onChange={(event) => {
                  if (activeThread) {
                    updateThreadDraft(activeThread.id, event.target.value);
                  }
                }}
                rows={5}
                placeholder="Tell codex what to do in this workspace..."
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    composerFormRef.current?.requestSubmit();
                  }
                }}
              />

              <div className="composer-controls">
                <button type="submit" disabled={activeThreadBusy}>
                  {activeThreadBusy ? "Running..." : "Send"}
                </button>
              </div>
            </form>
          </main>
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

      {sessionAlerts.length > 0 ? (
        <div className="session-alert-stack" role="status" aria-live="polite">
          {sessionAlerts.map((alert) => (
            <button key={alert.id} type="button" className="session-alert" onClick={() => openSessionFromAlert(alert)}>
              <strong>{alert.title}</strong>
              <span>{alert.body}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
