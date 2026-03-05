import {
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  API_BASE,
  type CodexPlatformResult,
} from "./api";
import { useOpsDomain } from "./domains/ops";
import {
  clearStoredToken,
  loadStoredToken,
} from "./domains/auth-token";
import {
  type TimelineEntry,
  useSessionDomain,
} from "./domains/session";
import { CommandPalette } from "./features/session/components/CommandPalette";
import { SessionComposer } from "./features/session/components/SessionComposer";
import { SessionHeader } from "./features/session/components/SessionHeader";
import { SessionSidebar } from "./features/session/components/SessionSidebar";
import { SessionTimeline } from "./features/session/components/SessionTimeline";
import { TokenGate } from "./features/session/components/TokenGate";
import { useAppMode } from "./features/session/use-app-mode";
import { useComposerAutoResize } from "./features/session/use-composer-autosize";
import { useCompletedRuns } from "./features/session/use-completed-runs";
import { useCommandPaletteController } from "./features/session/use-command-palette";
import { useGlobalShortcuts } from "./features/session/use-global-shortcuts";
import { useSessionAlerts } from "./features/session/use-session-alerts";
import { useSessionEventCursor } from "./features/session/use-session-event-cursor";
import { useOpsPolling } from "./features/session/use-ops-polling";
import { useSessionJobPolling } from "./features/session/use-session-job-polling";
import { useSessionRuntimeEffects } from "./features/session/use-session-runtime-effects";
import { useSessionStreamHealth } from "./features/session/use-session-stream-health";
import { useTimelineScrollController } from "./features/session/use-timeline-scroll";
import { createProjectSourceActions } from "./features/session/project-source-actions";
import { createHostActions } from "./features/session/host-actions";
import { createOpsJobActions } from "./features/session/ops-job-actions";
import { createPlatformActions } from "./features/session/platform-actions";
import { createProjectActions } from "./features/session/project-actions";
import { createComposerImageActions } from "./features/session/composer-image-actions";
import { createSessionControlActions } from "./features/session/session-control-actions";
import { createSessionSecondaryActions } from "./features/session/session-secondary-actions";
import { createSessionSubmitAction } from "./features/session/session-submit-action";
import { createWorkspaceAuthActions } from "./features/session/workspace-auth-actions";
import {
  buildSessionCommandPaletteActions,
  normalizeSearchText,
  type CommandPaletteAction,
} from "./features/session/command-palette";
import {
  APPROVAL_POLICY_OPTIONS,
  CODEX_PLATFORM_CLOUD_ACTIONS,
  CODEX_PLATFORM_MCP_ACTIONS,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  DEFAULT_WORKSPACE_PATH,
  MAX_COMPLETED_RUN_CACHE_SIZE,
  MAX_SESSION_STREAMS,
  TIMELINE_JUMP_COUNT_CAP,
  TIMELINE_STICK_GAP_PX,
  type CodexPlatformCloudAction,
  type CodexPlatformMCPAction,
} from "./features/session/config";
import {
  clearSessionRuntimePersistence,
  loadSessionTreePrefs,
  persistSessionTreePrefs,
} from "./features/session/persistence";
import {
  type SessionAlert,
  type SessionTreeHost,
} from "./features/session/types";
import {
  collectVisibleTreeSessionIDs,
  filterSessionTreeHosts,
  buildSessionTreeHosts,
} from "./features/session/tree";
import { buildSessionStreamTargetIDs } from "./features/session/stream-targets";
import {
  createSessionRunEventHandlers,
} from "./features/session/session-run-events";
import {
  createSessionStreamController,
  type SessionStreamRuntimeState,
} from "./features/session/session-stream-controller";
import type {
  SessionRunStreamState,
  SessionStreamHealthState,
} from "./features/session/stream-types";
import {
  formatClock,
  formatDateTime,
  isJobActive,
  lastUserPromptFromTimeline,
} from "./features/session/runtime-utils";
import {
  formatCodexPlatformResult,
  parseMessageSegments,
  shouldCollapseMessageBody,
  statusTone,
  streamHealthCopy,
  streamHealthTone,
} from "./features/session/view-helpers";
type AuthPhase = "checking" | "locked" | "ready";

function isLocalDraftSessionID(sessionID: string): boolean {
  return /^session_\d+_\d+$/.test(sessionID.trim());
}

export function App() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState<string>(
    () => loadStoredToken(),
  );
  const [authError, setAuthError] = useState("");
  const { appMode, switchMode } = useAppMode();
  const [platformHostID, setPlatformHostID] = useState("");
  const [platformBusySection, setPlatformBusySection] = useState<
    "" | "login" | "mcp" | "cloud"
  >("");
  const [platformNotice, setPlatformNotice] = useState("");
  const [platformLoginResult, setPlatformLoginResult] =
    useState<CodexPlatformResult | null>(null);
  const [platformMCPAction, setPlatformMCPAction] =
    useState<CodexPlatformMCPAction>("list");
  const [platformMCPName, setPlatformMCPName] = useState("");
  const [platformMCPURL, setPlatformMCPURL] = useState("");
  const [platformMCPCommand, setPlatformMCPCommand] = useState("");
  const [platformMCPEnvCSV, setPlatformMCPEnvCSV] = useState("");
  const [platformMCPBearerTokenEnvVar, setPlatformMCPBearerTokenEnvVar] =
    useState("");
  const [platformMCPScopeCSV, setPlatformMCPScopeCSV] = useState("");
  const [platformMCPResult, setPlatformMCPResult] =
    useState<CodexPlatformResult | null>(null);
  const [platformCloudAction, setPlatformCloudAction] =
    useState<CodexPlatformCloudAction>("list");
  const [platformCloudTaskID, setPlatformCloudTaskID] = useState("");
  const [platformCloudEnvID, setPlatformCloudEnvID] = useState("");
  const [platformCloudQuery, setPlatformCloudQuery] = useState("");
  const [platformCloudAttempts, setPlatformCloudAttempts] = useState("1");
  const [platformCloudBranch, setPlatformCloudBranch] = useState("");
  const [platformCloudLimit, setPlatformCloudLimit] = useState("20");
  const [platformCloudCursor, setPlatformCloudCursor] = useState("");
  const [platformCloudAttempt, setPlatformCloudAttempt] = useState("1");
  const [platformCloudResult, setPlatformCloudResult] =
    useState<CodexPlatformResult | null>(null);

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
    runSandbox,
    setRunSandbox,
    runAsyncMode,
    setRunAsyncMode,
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
    resetOpsDomain,
  } = ops;

  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceID,
    setActiveWorkspaceID,
    threads,
    activeThreadID,
    activateThread,
    activeJobThreadID,
    setActiveJobThreadID,
    completedJobsRef,
    activeThread,
    activeTimeline,
    activeDraft,
    updateThreadDraft,
    addTimelineEntry,
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    createThread,
    forkThread,
    removeThread,
    switchThreadByOffset,
    setThreadModel,
    setThreadSandbox,
    setThreadApprovalPolicy,
    setThreadWebSearch,
    setThreadProfile,
    addThreadConfigFlag,
    removeThreadConfigFlag,
    addThreadEnableFlag,
    removeThreadEnableFlag,
    addThreadDisableFlag,
    removeThreadDisableFlag,
    addThreadAddDir,
    removeThreadAddDir,
    setThreadSkipGitRepoCheck,
    setThreadEphemeral,
    setThreadJSONOutput,
    addThreadImagePath,
    removeThreadImagePath,
    setThreadJobState,
    setThreadUnread,
    setThreadTitle,
    setThreadPinned,
    bindThreadID,
    runningThreadJobs,
    syncProjectsFromDiscovery,
    syncProjectsFromServer,
    resetSessionDomain,
  } = session;

  const {
    notificationPermission,
    sessionAlerts,
    sessionAlertsExpanded,
    setSessionAlertsExpanded,
    pushSessionAlert,
    dismissSessionAlert,
    clearSessionAlerts,
    onEnableNotifications,
    notifySessionDone,
  } = useSessionAlerts();
  const {
    sessionEventCursorRef,
    setSessionEventCursor,
    deleteSessionEventCursor,
    pruneSessionEventCursors,
  } = useSessionEventCursor();
  const {
    sessionStreamHealthByID,
    updateSessionStreamHealth,
    clearSessionStreamHealth,
    clearAllSessionStreamHealth,
  } = useSessionStreamHealth();
  const {
    hydrateCompletedRuns,
    hasCompletedRun,
    markRunCompleted,
    clearCompletedRuns,
  } = useCompletedRuns(completedJobsRef, MAX_COMPLETED_RUN_CACHE_SIZE);
  const [submittingThreadID, setSubmittingThreadID] = useState("");
  const [cancelingThreadID, setCancelingThreadID] = useState("");
  const [deletingThreadID, setDeletingThreadID] = useState("");
  const [deletingProjectID, setDeletingProjectID] = useState("");
  const [upsertingProjectID, setUpsertingProjectID] = useState("");
  const [sessionModelDefault, setSessionModelDefault] = useState("");
  const [sessionModelOptions, setSessionModelOptions] = useState<string[]>([]);
  const [sourceProjectIDs, setSourceProjectIDs] = useState<string[]>([]);
  const [projectComposerOpen, setProjectComposerOpen] = useState(false);
  const [projectFormHostID, setProjectFormHostID] = useState("");
  const [projectFormPath, setProjectFormPath] = useState("");
  const [projectFormTitle, setProjectFormTitle] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState("");
  const [sessionAdvancedOpen, setSessionAdvancedOpen] = useState(false);
  const [addDirDraft, setAddDirDraft] = useState("");
  const [configFlagDraft, setConfigFlagDraft] = useState("");
  const [enableFlagDraft, setEnableFlagDraft] = useState("");
  const [disableFlagDraft, setDisableFlagDraft] = useState("");
  const [composerDropActive, setComposerDropActive] = useState(false);
  const sessionTreePrefs = useMemo(() => loadSessionTreePrefs(), []);
  const [projectFilter, setProjectFilter] = useState(sessionTreePrefs.projectFilter);
  const [collapsedHostIDs, setCollapsedHostIDs] = useState<string[]>(
    sessionTreePrefs.collapsedHostIDs,
  );
  const [treeCursorSessionID, setTreeCursorSessionID] = useState("");
  const [expandedMessageIDs, setExpandedMessageIDs] = useState<string[]>([]);
  const [copiedCodeKey, setCopiedCodeKey] = useState("");
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const composerDragDepthRef = useRef(0);
  const copyResetTimerRef = useRef<number | null>(null);
  const jobEventCursorRef = useRef<Map<string, number>>(new Map());
  const jobStreamSeenRef = useRef<Map<string, boolean>>(new Map());
  const jobNoTextFinalizeRetriesRef = useRef<Map<string, number>>(new Map());
  const sessionStreamStateRef = useRef<Map<string, SessionStreamRuntimeState>>(
    new Map(),
  );
  const sessionEventQueueRef = useRef<Map<string, Promise<void>>>(new Map());
  const sessionRunStateRef = useRef<Map<string, SessionRunStreamState>>(
    new Map(),
  );
  const streamAuthTokenRef = useRef("");
  const completionAlertCutoffMSRef = useRef<number>(Date.now());
  const activeThreadIDRef = useRef(activeThreadID);
  const threadTitleMapRef = useRef<Map<string, string>>(new Map());
  const threadWorkspaceMapRef = useRef<Map<string, string>>(new Map());
  const runningSessionIDsRef = useRef<Set<string>>(new Set());
  const tokenRef = useRef(token);
  const archiveSessionActionRef = useRef<() => Promise<void>>(async () => {});
  const reconnectStreamActionRef = useRef<() => void>(() => {});
  const forkSessionActionRef = useRef<() => Promise<void>>(async () => {});

  const activeRuntime = useMemo(
    () =>
      runtimes.find((runtime) => runtime.name === selectedRuntime) ??
      runtimes[0] ??
      null,
    [runtimes, selectedRuntime],
  );
  const activeSessionStreamHealth = activeThreadID
    ? sessionStreamHealthByID[activeThreadID]
    : undefined;
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
  const sessionStreamTargetIDs = useMemo(
    () =>
      buildSessionStreamTargetIDs(
        workspaces,
        activeThreadID,
        MAX_SESSION_STREAMS,
      ),
    [workspaces, activeThreadID],
  );
  const activeSessionHostID = activeWorkspace?.hostID?.trim() ?? "";
  const sessionTreeHosts = useMemo<SessionTreeHost[]>(
    () => buildSessionTreeHosts(hosts, workspaces, activeWorkspaceID),
    [hosts, workspaces, activeWorkspaceID],
  );
  const sourceProjectIDSet = useMemo(
    () =>
      new Set(
        sourceProjectIDs
          .map((id) => id.trim())
          .filter((id) => id !== ""),
      ),
    [sourceProjectIDs],
  );
  const filteredSessionTreeHosts = useMemo<SessionTreeHost[]>(
    () => filterSessionTreeHosts(sessionTreeHosts, projectFilter),
    [projectFilter, sessionTreeHosts],
  );
  const visibleTreeSessionIDs = useMemo(
    () => collectVisibleTreeSessionIDs(filteredSessionTreeHosts, collapsedHostIDs),
    [collapsedHostIDs, filteredSessionTreeHosts],
  );
  const activeThreadBusy =
    Boolean(activeThread?.activeJobID) ||
    (activeThread ? submittingThreadID === activeThread.id : false) ||
    (activeThread ? deletingThreadID === activeThread.id : false) ||
    (activeThread ? cancelingThreadID === activeThread.id : false);
  const activeThreadRunID = activeThread?.activeJobID.trim() ?? "";
  const hasRegeneratePrompt =
    activeThread !== null &&
    lastUserPromptFromTimeline(activeThread.timeline).trim() !== "";
  const activeThreadStatusCopy = activeThreadBusy
    ? "Codex is thinking..."
    : activeThread?.lastJobStatus === "failed"
      ? "Last response failed."
      : activeThread?.lastJobStatus === "canceled"
        ? "Last response interrupted."
        : "";
  const activeStreamState: SessionStreamHealthState = activeSessionStreamHealth
    ? activeSessionStreamHealth.state
    : activeThreadID
      ? "connecting"
      : "offline";
  const activeStreamRetries = activeSessionStreamHealth?.retries ?? 0;
  const activeStreamCopy = streamHealthCopy(activeStreamState, activeStreamRetries);
  const activeStreamTone = streamHealthTone(activeStreamState);
  const activeStreamLastError =
    activeSessionStreamHealth?.lastError.trim() ?? "";
  const canReconnectActiveStream =
    authPhase === "ready" && token.trim() !== "" && activeThreadID.trim() !== "";
  const activeThreadModelValue = useMemo(() => {
    const current = activeThread?.model.trim() ?? "";
    if (current) return current;
    if (sessionModelDefault.trim()) return sessionModelDefault.trim();
    return sessionModelOptions[0]?.trim() ?? "";
  }, [activeThread?.model, sessionModelDefault, sessionModelOptions]);
  const sessionModelChoices = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (modelName: string) => {
      const trimmed = modelName.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      out.push(trimmed);
    };
    push(sessionModelDefault);
    for (const modelName of sessionModelOptions) push(modelName);
    if (activeThreadModelValue) push(activeThreadModelValue);
    return out;
  }, [sessionModelDefault, sessionModelOptions, activeThreadModelValue]);
  const hasSessionModelChoices = sessionModelChoices.length > 0;
  const commandPaletteActions = useMemo<CommandPaletteAction[]>(() => {
    if (appMode !== "session") return [];
    return buildSessionCommandPaletteActions({
      activeWorkspaceTitle: activeWorkspace?.title?.trim() || "",
      threadsLength: threads.length,
      activeThreadID,
      activeThread,
      activeThreadBusy,
      workspaces,
      sessionModelChoices,
      sessionModelDefault,
      onFocusComposer: () => {
        promptInputRef.current?.focus();
      },
      onCreateSession: createThreadAndFocus,
      onSwitchPrevSession: () => {
        switchThreadByOffset(-1);
      },
      onSwitchNextSession: () => {
        switchThreadByOffset(1);
      },
      onForkSession: () => {
        void forkSessionActionRef.current();
      },
      onTogglePinSession: setThreadPinned,
      onArchiveSession: () => {
        void archiveSessionActionRef.current();
      },
      onReconnectStream: () => {
        reconnectStreamActionRef.current();
      },
      onOpenProject: (workspaceID, preferredSessionID) => {
        if (preferredSessionID) {
          activateThread(preferredSessionID);
          focusComposerSoon();
          return;
        }
        setActiveWorkspaceID(workspaceID);
        focusComposerSoon();
      },
      onSetModel: setThreadModel,
    });
  }, [
    appMode,
    activeWorkspace?.title,
    threads.length,
    activeThreadID,
    activeThread,
    activeThreadBusy,
    workspaces,
    sessionModelChoices,
    sessionModelDefault,
    setActiveWorkspaceID,
    setThreadModel,
    setThreadPinned,
    switchThreadByOffset,
    activateThread,
  ]);
  const {
    commandPaletteOpen,
    commandPaletteQuery,
    commandPaletteCursor,
    commandPaletteInputRef,
    setCommandPaletteCursor,
    openCommandPalette,
    closeCommandPalette,
    runCommandPaletteAction,
    onCommandPaletteKeyDown,
    onCommandPaletteQueryChange,
  } = useCommandPaletteController({
    sessionModeActive: appMode === "session",
    getFilteredActionsLength: () => filteredCommandPaletteActions.length,
    onRunActionAt: (index) => {
      const action = filteredCommandPaletteActions[index];
      if (!action) return;
      action.run();
    },
    onFocusComposer: focusComposerSoon,
  });
  const filteredCommandPaletteActions = useMemo(() => {
    const query = normalizeSearchText(commandPaletteQuery);
    if (!query) return commandPaletteActions.slice(0, 48);
    return commandPaletteActions
      .filter((action) => action.searchText.includes(query))
      .slice(0, 48);
  }, [commandPaletteActions, commandPaletteQuery]);
  const activeTimelineTail = activeTimeline[activeTimeline.length - 1];
  const {
    timelineUnreadCount,
    timelineViewportRef,
    timelineBottomRef,
    onTimelineScroll,
    jumpTimelineToLatest,
    forceStickToBottom,
  } = useTimelineScrollController({
    activeThreadID,
    timelineLength: activeTimeline.length,
    timelineTailID: activeTimelineTail?.id ?? "",
    timelineTailState: activeTimelineTail?.state ?? "",
    timelineTailBody: activeTimelineTail?.body ?? "",
    stickGapPx: TIMELINE_STICK_GAP_PX,
    jumpCountCap: TIMELINE_JUMP_COUNT_CAP,
  });
  useComposerAutoResize({
    inputRef: promptInputRef,
    value: activeDraft,
    activeThreadID,
    minHeight: COMPOSER_MIN_HEIGHT,
    maxHeight: COMPOSER_MAX_HEIGHT,
  });
  useGlobalShortcuts({
    authReady: authPhase === "ready",
    appMode,
    commandPaletteOpen,
    onOpenCommandPalette: () => openCommandPalette(),
    onCloseCommandPalette: () => closeCommandPalette(),
    onCreateThreadAndFocus: createThreadAndFocus,
    onSwitchThreadByOffset: switchThreadByOffset,
  });

  const activeProgress = useMemo(() => {
    if (!activeJob) return 0;
    const total = activeJob.total_hosts ?? 0;
    if (total <= 0) return isJobActive(activeJob) ? 0 : 100;
    const done =
      (activeJob.succeeded_hosts ?? 0) + (activeJob.failed_hosts ?? 0);
    if (!isJobActive(activeJob)) return 100;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }, [activeJob]);

  const filteredOpsJobs = useMemo(() => {
    const byStatus =
      opsJobStatusFilter === "all"
        ? jobs
        : jobs.filter((job) => job.status === opsJobStatusFilter);
    if (opsJobTypeFilter === "all") return byStatus;
    return byStatus.filter((job) => job.type === opsJobTypeFilter);
  }, [jobs, opsJobStatusFilter, opsJobTypeFilter]);
  const knownJobIDSet = useMemo(
    () =>
      new Set(
        jobs
          .map((job) => job.id.trim())
          .filter((id) => id !== ""),
      ),
    [jobs],
  );
  const runningJobPollTargets = useMemo(
    () =>
      runningThreadJobs.filter((item) => knownJobIDSet.has(item.jobID.trim())),
    [runningThreadJobs, knownJobIDSet],
  );

  const filteredHosts = useMemo(() => {
    const query = hostFilter.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => {
      const text =
        `${host.name} ${host.host} ${host.user} ${host.workspace ?? ""} ${host.connection_mode ?? "ssh"}`.toLowerCase();
      return text.includes(query);
    });
  }, [hosts, hostFilter]);
  const platformHost = useMemo(
    () => hosts.find((host) => host.id === platformHostID) ?? null,
    [hosts, platformHostID],
  );

  const filteredOpsRuns = useMemo(() => {
    if (opsRunStatusFilter === "all") return runs;
    if (opsRunStatusFilter === "ok")
      return runs.filter((run) => run.status_code < 400);
    return runs.filter((run) => run.status_code >= 400);
  }, [runs, opsRunStatusFilter]);

  const filteredAuditEvents = useMemo(() => {
    return auditEvents.filter((evt) => {
      if (opsAuditMethodFilter !== "all" && evt.method !== opsAuditMethodFilter)
        return false;
      if (
        opsAuditStatusFilter === "2xx" &&
        (evt.status_code < 200 || evt.status_code >= 300)
      )
        return false;
      if (
        opsAuditStatusFilter === "4xx" &&
        (evt.status_code < 400 || evt.status_code >= 500)
      )
        return false;
      if (
        opsAuditStatusFilter === "5xx" &&
        (evt.status_code < 500 || evt.status_code >= 600)
      )
        return false;
      return true;
    });
  }, [auditEvents, opsAuditMethodFilter, opsAuditStatusFilter]);
  const healthIsError = health.startsWith("error");
  const opsNoticeIsError = /fail|error|degraded/i.test(opsNotice);
  const syncLabel = isRefreshing ? "syncing" : "live";

  useEffect(() => {
    if (hosts.length === 0) {
      if (platformHostID) {
        setPlatformHostID("");
      }
      return;
    }
    if (platformHostID && hosts.some((host) => host.id === platformHostID)) {
      return;
    }
    const workspaceHostID = activeWorkspace?.hostID?.trim() ?? "";
    if (workspaceHostID && hosts.some((host) => host.id === workspaceHostID)) {
      setPlatformHostID(workspaceHostID);
      return;
    }
    setPlatformHostID(hosts[0].id);
  }, [hosts, activeWorkspace?.hostID, platformHostID]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    hydrateCompletedRuns();
  }, [hydrateCompletedRuns]);

  useEffect(() => {
    activeThreadIDRef.current = activeThreadID;
  }, [activeThreadID]);

  useEffect(() => {
    threadTitleMapRef.current = threadTitleMap;
  }, [threadTitleMap]);

  useEffect(() => {
    threadWorkspaceMapRef.current = threadWorkspaceMap;
  }, [threadWorkspaceMap]);

  useEffect(() => {
    const running = new Set<string>();
    const validSessionIDs = new Set<string>();
    for (const workspace of workspaces) {
      for (const sessionItem of workspace.sessions) {
        validSessionIDs.add(sessionItem.id);
        if (sessionItem.activeJobID.trim()) {
          running.add(sessionItem.id);
        }
      }
    }
    pruneSessionEventCursors(validSessionIDs);
    for (const sessionID of Array.from(sessionEventQueueRef.current.keys())) {
      if (validSessionIDs.has(sessionID)) continue;
      sessionEventQueueRef.current.delete(sessionID);
    }
    runningSessionIDsRef.current = running;
  }, [workspaces, pruneSessionEventCursors]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const title = activeThread?.title.trim() || "Session";
    document.title = `${title} · Codex Control App`;
  }, [activeThread?.title]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const runningSessionIDs = new Set<string>();
      for (const workspace of workspaces) {
        for (const thread of workspace.sessions) {
          if (thread.activeJobID.trim()) {
            runningSessionIDs.add(thread.id);
          }
        }
      }
      for (const [sessionID, state] of sessionStreamStateRef.current.entries()) {
        if (!runningSessionIDs.has(sessionID)) continue;
        if (state.lastEventAt <= 0) continue;
        if (now - state.lastEventAt < 16_000) continue;
        updateSessionStreamHealth(sessionID, "reconnecting", {
          lastEventAt: state.lastEventAt,
          lastError: "stream idle, retrying",
          throttleMS: 0,
        });
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [workspaces]);

  useEffect(() => {
    persistSessionTreePrefs({
      projectFilter,
      collapsedHostIDs,
    });
  }, [projectFilter, collapsedHostIDs]);

  useEffect(() => {
    if (sessionTreeHosts.length === 0) return;
    const validHostIDs = new Set(sessionTreeHosts.map((item) => item.hostID));
    setCollapsedHostIDs((prev) => {
      const next = prev.filter((hostID) => validHostIDs.has(hostID));
      return next.length === prev.length ? prev : next;
    });
  }, [sessionTreeHosts]);

  useEffect(() => {
    if (!projectComposerOpen) return;
    const fallbackHostID = activeWorkspace?.hostID?.trim() || hosts[0]?.id || "";
    if (
      !projectFormHostID ||
      !hosts.some((host) => host.id === projectFormHostID)
    ) {
      setProjectFormHostID(fallbackHostID);
    }
    if (!projectFormPath.trim()) {
      setProjectFormPath(activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH);
    }
  }, [
    projectComposerOpen,
    projectFormHostID,
    projectFormPath,
    activeWorkspace?.hostID,
    activeWorkspace?.path,
    hosts,
  ]);

  useEffect(() => {
    if (activeThreadID.trim()) {
      setTreeCursorSessionID(activeThreadID);
    }
  }, [activeThreadID]);

  useEffect(() => {
    composerDragDepthRef.current = 0;
    setComposerDropActive(false);
    setAddDirDraft("");
    setSessionAdvancedOpen(false);
  }, [activeThreadID]);

  useEffect(() => {
    if (visibleTreeSessionIDs.length === 0) {
      setTreeCursorSessionID("");
      return;
    }
    setTreeCursorSessionID((prev) =>
      prev && visibleTreeSessionIDs.includes(prev) ? prev : visibleTreeSessionIDs[0],
    );
  }, [visibleTreeSessionIDs]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  function createThreadAndFocus() {
    createThread();
    focusComposerSoon();
  }

  function focusComposerSoon() {
    window.requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });
  }

  function onAddDirDraftSubmit() {
    if (!activeThread) return;
    const trimmed = addDirDraft.trim();
    if (!trimmed) return;
    addThreadAddDir(activeThread.id, trimmed);
    setAddDirDraft("");
  }

  function onConfigFlagDraftSubmit() {
    if (!activeThread) return;
    const trimmed = configFlagDraft.trim();
    if (!trimmed) return;
    addThreadConfigFlag(activeThread.id, trimmed);
    setConfigFlagDraft("");
  }

  function onEnableFlagDraftSubmit() {
    if (!activeThread) return;
    const trimmed = enableFlagDraft.trim();
    if (!trimmed) return;
    addThreadEnableFlag(activeThread.id, trimmed);
    setEnableFlagDraft("");
  }

  function onDisableFlagDraftSubmit() {
    if (!activeThread) return;
    const trimmed = disableFlagDraft.trim();
    if (!trimmed) return;
    addThreadDisableFlag(activeThread.id, trimmed);
    setDisableFlagDraft("");
  }

  function openProjectComposer() {
    const fallbackHostID = activeWorkspace?.hostID?.trim() || hosts[0]?.id || "";
    const fallbackPath = activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH;
    setProjectComposerOpen(true);
    setProjectFormHostID(fallbackHostID);
    setProjectFormPath(fallbackPath);
    setProjectFormTitle("");
  }

  function closeProjectComposer() {
    setProjectComposerOpen(false);
    setProjectFormTitle("");
  }

  function registerSessionButtonRef(
    sessionID: string,
    node: HTMLButtonElement | null,
  ) {
    if (!sessionID) return;
    if (node) {
      sessionButtonRefs.current.set(sessionID, node);
      return;
    }
    sessionButtonRefs.current.delete(sessionID);
  }

  function moveTreeCursor(step: number) {
    if (visibleTreeSessionIDs.length === 0) return;
    const currentIndex = Math.max(
      0,
      visibleTreeSessionIDs.findIndex((id) => id === treeCursorSessionID),
    );
    const nextIndex =
      (currentIndex + step + visibleTreeSessionIDs.length) %
      visibleTreeSessionIDs.length;
    const nextID = visibleTreeSessionIDs[nextIndex];
    setTreeCursorSessionID(nextID);
    const node = sessionButtonRefs.current.get(nextID);
    node?.focus();
  }

  function onSessionTreeKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionID: string,
    pinned: boolean,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTreeCursor(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTreeCursor(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      const nextID = visibleTreeSessionIDs[0];
      if (!nextID) return;
      setTreeCursorSessionID(nextID);
      sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const nextID = visibleTreeSessionIDs[visibleTreeSessionIDs.length - 1];
      if (!nextID) return;
      setTreeCursorSessionID(nextID);
      sessionButtonRefs.current.get(nextID)?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setTreeCursorSessionID(sessionID);
      activateThread(sessionID);
      focusComposerSoon();
      return;
    }
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      setThreadPinned(sessionID, !pinned);
    }
  }

  function toggleMessageExpanded(entryID: string) {
    setExpandedMessageIDs((prev) =>
      prev.includes(entryID)
        ? prev.filter((id) => id !== entryID)
        : [...prev, entryID],
    );
  }

  async function copyToClipboard(content: string, key: string) {
    const text = content ?? "";
    if (!text) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopiedCodeKey(key);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedCodeKey("");
      }, 1500);
    } catch {
      setCopiedCodeKey("");
    }
  }

  function renderTimelineEntryBody(entry: TimelineEntry) {
    const segments = parseMessageSegments(entry.body);
    const collapsible = shouldCollapseMessageBody(entry.body);
    const expanded = expandedMessageIDs.includes(entry.id);
    const showCollapsed = collapsible && !expanded;
    const wrapperClass = `message-body${showCollapsed ? " message-body-collapsed" : ""}`;
    const canEditAndResend =
      entry.kind === "user" && authPhase === "ready" && token.trim() !== "";
    return (
      <div className={wrapperClass}>
        {segments.map((segment, index) =>
          segment.kind === "text" ? (
            <pre key={`${entry.id}_text_${index}`}>{segment.content}</pre>
          ) : (
            <section key={`${entry.id}_code_${index}`} className="message-code-block">
              <header className="message-code-head">
                <span>{segment.lang || "code"}</span>
                <button
                  type="button"
                  className="ghost code-copy-btn"
                  onClick={() => void copyToClipboard(segment.content, `${entry.id}_${index}`)}
                >
                  {copiedCodeKey === `${entry.id}_${index}` ? "Copied" : "Copy"}
                </button>
              </header>
              <pre className="message-code-pre">{segment.content}</pre>
            </section>
          ),
        )}
        {showCollapsed ? <div className="message-collapse-mask" aria-hidden="true" /> : null}
        {collapsible ? (
          <div className="message-collapse-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => toggleMessageExpanded(entry.id)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        ) : null}
        {canEditAndResend ? (
          <div className="message-user-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => void onEditAndResend(entry)}
              disabled={activeThreadBusy}
            >
              Edit & Resend
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  function toggleHostCollapsed(hostID: string) {
    setCollapsedHostIDs((prev) =>
      prev.includes(hostID)
        ? prev.filter((id) => id !== hostID)
        : [...prev, hostID],
    );
  }

  function shouldSurfaceCompletion(createdAt?: string): boolean {
    const ts = createdAt?.trim();
    if (!ts) return false;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) return false;
    return parsed >= completionAlertCutoffMSRef.current;
  }

  function openSessionFromAlert(alert: SessionAlert) {
    if (threadWorkspaceMap.has(alert.threadID)) {
      activateThread(alert.threadID);
      switchMode("session");
      focusComposerSoon();
    }
    dismissSessionAlert(alert.id);
  }

  const { ensureLocalCodexHost, refreshProjectsFromSource } =
    createProjectSourceActions({
      activeWorkspacePath: activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
      workspaces,
      setSourceProjectIDs,
      syncProjectsFromDiscovery,
      syncProjectsFromServer,
      setThreadJobState,
    });

  const { handleSessionEventRecord } = createSessionRunEventHandlers({
    workspaces,
    sessionRunStateRef,
    activeThreadIDRef,
    threadTitleMapRef,
    setThreadJobState,
    setThreadUnread,
    setThreadTitle,
    setActiveJobID,
    addTimelineEntry,
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    notifySessionDone,
    pushSessionAlert,
    markRunCompleted,
    hasCompletedRun,
    shouldSurfaceCompletion,
  });
  const { stopSessionStream, stopAllSessionStreams, startSessionStream } =
    createSessionStreamController({
      sessionStreamStateRef,
      sessionEventQueueRef,
      sessionRunStateRef,
      runningSessionIDsRef,
      sessionEventCursorRef,
      setSessionEventCursor,
      updateSessionStreamHealth,
      clearSessionStreamHealth,
      clearAllSessionStreamHealth,
      handleSessionEventRecord,
    });

  const { loadWorkspace, unlockWorkspace } = createWorkspaceAuthActions({
    selectedRuntime,
    workspacesLength: workspaces.length,
    setIsRefreshing,
    setHealth,
    setHosts,
    setRuntimes,
    setJobs,
    setRuns,
    setAuditEvents,
    setMetrics,
    setAllHosts,
    setSelectedHostIDs,
    setSelectedRuntime,
    setActiveJobID,
    setActiveJob,
    setToken,
    setTokenInput,
    setAuthError,
    setAuthPhase,
    ensureLocalCodexHost,
    refreshProjectsFromSource,
    jobEventCursorRef,
    jobStreamSeenRef,
    completionAlertCutoffMSRef,
  });

  useEffect(() => {
    const cached = loadStoredToken();
    if (!cached.trim()) {
      setAuthPhase("locked");
      return;
    }
    void unlockWorkspace(cached);
  }, []);

  useSessionRuntimeEffects({
    authPhase,
    token,
    appMode,
    sessionStreamTargetIDs,
    sessionStreamStateRef,
    streamAuthTokenRef,
    stopAllSessionStreams,
    startSessionStream,
    stopSessionStream,
    activeSessionHostID,
    runtimes,
    setSessionModelDefault,
    setSessionModelOptions,
    hosts,
    runningThreadJobsLength: runningThreadJobs.length,
    submittingThreadID,
    refreshProjectsFromSource,
    activeThreadID,
    activeThreadActiveJobID: activeThread?.activeJobID?.trim() ?? "",
    knownJobIDSet,
    setActiveJobID,
    setActiveJob,
  });

  useSessionJobPolling({
    authPhase,
    token,
    appMode,
    runningJobPollTargets,
    activeThreadID,
    hosts,
    runtimes,
    jobEventCursorRef,
    jobStreamSeenRef,
    jobNoTextFinalizeRetriesRef,
    sessionRunStateRef,
    threadTitleMapRef,
    hasCompletedRun,
    markRunCompleted,
    shouldSurfaceCompletion,
    addTimelineEntry,
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    setThreadTitle,
    setThreadJobState,
    setThreadUnread,
    notifySessionDone,
    pushSessionAlert,
    setActiveJobID,
    setActiveJob,
    setJobs,
    setRuns,
    setAuditEvents,
    setMetrics,
    refreshProjectsFromSource,
  });

  useOpsPolling({
    authPhase,
    token,
    appMode,
    activeJobID,
    setJobs,
    setRuns,
    setAuditEvents,
    setMetrics,
    setActiveJobID,
    setActiveJob,
  });

  async function onSubmitToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await unlockWorkspace(tokenInput);
  }

  function onLogout() {
    clearStoredToken();
    clearSessionRuntimePersistence();
    stopAllSessionStreams();
    streamAuthTokenRef.current = "";
    resetOpsDomain();
    resetSessionDomain();
    jobEventCursorRef.current.clear();
    jobStreamSeenRef.current.clear();
    jobNoTextFinalizeRetriesRef.current.clear();
    sessionEventCursorRef.current.clear();
    sessionRunStateRef.current.clear();
    clearCompletedRuns();
    setSubmittingThreadID("");
    setCancelingThreadID("");
    clearSessionAlerts();
    setSessionModelDefault("");
    setSessionModelOptions([]);
    setSourceProjectIDs([]);
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

  const { onCreateProject, onRenameProject, onArchiveProject } =
    createProjectActions({
      authPhase,
      token,
      projectFormHostID,
      projectFormPath,
      projectFormTitle,
      hosts,
      sourceProjectIDSet,
      activeThreadID,
      addTimelineEntry,
      setUpsertingProjectID,
      setDeletingProjectID,
      setSourceProjectIDs,
      setActiveWorkspaceID,
      closeProjectComposer,
      refreshProjectsFromSource,
    });

  const { onRefreshWorkspace, onArchiveActiveSession, onReconnectActiveStream } =
    createSessionControlActions({
      authPhase,
      token,
      activeThread,
      activeThreadID,
      submittingThreadID,
      activeWorkspaceHostID: activeWorkspace?.hostID?.trim() ?? "",
      activeWorkspaceHostName: activeWorkspace?.hostName?.trim() ?? "",
      hosts,
      sessionRunStateRef,
      addTimelineEntry,
      removeThread,
      stopSessionStream,
      deleteSessionEventCursor,
      refreshProjectsFromSource,
      updateSessionStreamHealth,
      startSessionStream,
      loadWorkspace,
      isLocalDraftSessionID,
      setDeletingThreadID,
    });
  archiveSessionActionRef.current = onArchiveActiveSession;
  reconnectStreamActionRef.current = onReconnectActiveStream;

  const { submitPromptForActiveThread } = createSessionSubmitAction({
    authPhase,
    token,
    activeThread,
    submittingThreadID,
    activeWorkspaceHostID: activeWorkspace?.hostID?.trim() ?? "",
    activeWorkspacePath: activeWorkspace?.path?.trim() ?? "",
    hosts,
    selectedHostIDs,
    sessionModelDefault,
    sessionModelChoices,
    runSandbox,
    activeRuntimeName: activeRuntime?.name ?? selectedRuntime,
    selectedRuntime,
    activeThreadIDRef,
    sessionRunStateRef,
    sessionStreamStateRef,
    addTimelineEntry,
    setThreadTitle,
    forceStickToBottom,
    updateThreadDraft,
    bindThreadID,
    stopSessionStream,
    deleteSessionEventCursor,
    setThreadJobState,
    setActiveJobThreadID,
    setActiveJobID,
    startSessionStream,
    setSubmittingThreadID,
    finalizeAssistantStreamEntry,
    isLocalDraftSessionID,
  });

  const {
    onSendPrompt,
    onStopActiveSessionRun,
    onRegenerateActiveSession,
    onForkActiveSession,
    onEditAndResend,
  } = createSessionSecondaryActions({
    authPhase,
    token,
    activeThread,
    activeWorkspaceHostID: activeWorkspace?.hostID?.trim() ?? "",
    activeWorkspacePath: activeWorkspace?.path?.trim() ?? "",
    activeRuntimeName: activeRuntime?.name ?? selectedRuntime,
    hosts,
    cancelingThreadID,
    promptInputRef,
    addTimelineEntry,
    submitPromptForActiveThread,
    refreshProjectsFromSource,
    activateThread,
    forkThread,
    isLocalDraftSessionID,
    setCancelingThreadID,
  });
  forkSessionActionRef.current = onForkActiveSession;

  const { onRunPlatformLogin, onRunPlatformMCP, onRunPlatformCloud } =
    createPlatformActions({
      authPhase,
      token,
      platformHostID,
      platformHostName: platformHost?.name ?? "",
      platformMCPAction,
      platformMCPName,
      platformMCPURL,
      platformMCPCommand,
      platformMCPEnvCSV,
      platformMCPBearerTokenEnvVar,
      platformMCPScopeCSV,
      platformCloudAction,
      platformCloudTaskID,
      platformCloudEnvID,
      platformCloudQuery,
      platformCloudAttempts,
      platformCloudBranch,
      platformCloudLimit,
      platformCloudCursor,
      platformCloudAttempt,
      setPlatformBusySection,
      setPlatformNotice,
      setPlatformLoginResult,
      setPlatformMCPResult,
      setPlatformCloudResult,
    });

  const {
    onAddHost,
    onStartEditHost,
    onCancelHostEdit,
    onProbeHost,
    onDeleteHost,
  } = createHostActions({
    authPhase,
    token,
    hostForm,
    editingHostID,
    setHostForm,
    setEditingHostID,
    setAddingHost,
    setOpsHostBusyID,
    setOpsNotice,
    setSelectedHostIDs,
    addTimelineEntry,
    loadWorkspace,
  });

  const { onCancelJob } = createOpsJobActions({
    authPhase,
    token,
    runningThreadJobs,
    setThreadJobState,
    setOpsNotice,
    loadWorkspace,
  });

  const {
    onUploadSessionImage,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = createComposerImageActions({
    authPhase,
    token,
    activeThreadID: activeThread?.id ?? "",
    activeThreadBusy,
    composerDropActive,
    composerDragDepthRef,
    setUploadingImage,
    setImageUploadError,
    setComposerDropActive,
    addThreadImagePath,
  });

  if (authPhase !== "ready") {
    return (
      <TokenGate
        tokenInput={tokenInput}
        authPhase={authPhase}
        authError={authError}
        apiBase={API_BASE}
        onTokenInputChange={setTokenInput}
        onSubmitToken={onSubmitToken}
      />
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
            <button
              type="button"
              className={appMode === "session" ? "mode-btn active" : "mode-btn"}
              onClick={() => switchMode("session")}
            >
              Session
            </button>
            <button
              type="button"
              className={appMode === "ops" ? "mode-btn active" : "mode-btn"}
              onClick={() => switchMode("ops")}
            >
              Ops
            </button>
          </div>
          <span
            className={`sync-pill ${isRefreshing ? "busy" : healthIsError ? "error" : "ok"}`}
          >
            {syncLabel}
          </span>
          <button
            onClick={() => void onRefreshWorkspace()}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Syncing..." : "Sync"}
          </button>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      {healthIsError ? (
        <section className="workspace-alert">
          Controller state degraded: {health}
        </section>
      ) : null}

      {appMode === "session" ? (
        <div className="session-stage">
          <SessionSidebar
            authReady={authPhase === "ready"}
            hasToken={token.trim() !== ""}
            hosts={hosts}
            projectComposerOpen={projectComposerOpen}
            onOpenProjectComposer={openProjectComposer}
            onCreateThread={createThreadAndFocus}
            onCreateProject={onCreateProject}
            projectFormHostID={projectFormHostID}
            setProjectFormHostID={setProjectFormHostID}
            projectFormPath={projectFormPath}
            setProjectFormPath={setProjectFormPath}
            projectFormTitle={projectFormTitle}
            setProjectFormTitle={setProjectFormTitle}
            upsertingProjectID={upsertingProjectID}
            onCloseProjectComposer={closeProjectComposer}
            projectFilter={projectFilter}
            setProjectFilter={setProjectFilter}
            sessionTreeHosts={sessionTreeHosts}
            filteredSessionTreeHosts={filteredSessionTreeHosts}
            collapsedHostIDs={collapsedHostIDs}
            onToggleHostCollapsed={toggleHostCollapsed}
            activeWorkspaceID={activeWorkspaceID}
            onSelectWorkspace={setActiveWorkspaceID}
            onFocusComposer={focusComposerSoon}
            onRenameProject={(projectNode) => {
              void onRenameProject(projectNode);
            }}
            onArchiveProject={(projectID, hostID, path, sessionCount) => {
              void onArchiveProject(projectID, hostID, path, sessionCount);
            }}
            deletingProjectID={deletingProjectID}
            registerSessionButtonRef={registerSessionButtonRef}
            activeThreadID={activeThreadID}
            treeCursorSessionID={treeCursorSessionID}
            setTreeCursorSessionID={setTreeCursorSessionID}
            onActivateThread={activateThread}
            onSetThreadPinned={setThreadPinned}
            onSessionTreeKeyDown={onSessionTreeKeyDown}
            notificationPermission={notificationPermission}
            onEnableNotifications={() => {
              void onEnableNotifications();
            }}
            onToggleAlertsExpanded={() =>
              setSessionAlertsExpanded((prev) => !prev)}
            sessionAlertsExpanded={sessionAlertsExpanded}
            sessionAlerts={sessionAlerts}
            onClearSessionAlerts={clearSessionAlerts}
            onOpenSessionFromAlert={openSessionFromAlert}
          />
          <main className="chat-pane">
            <SessionHeader
              title={activeThread?.title ?? "Session"}
              context={
                (activeWorkspace?.hostName?.trim() || "local-default") +
                " · " +
                (activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH)
              }
              streamTone={activeStreamTone}
              streamCopy={activeStreamCopy}
              streamLastError={activeStreamLastError}
              canArchive={Boolean(activeThread) && !activeThreadBusy}
              archiving={Boolean(activeThread && deletingThreadID === activeThread.id)}
              onArchive={() => {
                void onArchiveActiveSession();
              }}
              canReconnect={canReconnectActiveStream}
              onReconnect={onReconnectActiveStream}
            />
            <SessionTimeline
              timeline={activeTimeline}
              isRefreshing={isRefreshing}
              renderTimelineEntryBody={renderTimelineEntryBody}
              formatClock={formatClock}
              timelineViewportRef={timelineViewportRef}
              timelineBottomRef={timelineBottomRef}
              onTimelineScroll={onTimelineScroll}
              timelineUnreadCount={timelineUnreadCount}
              onJumpTimelineToLatest={jumpTimelineToLatest}
            />
            <SessionComposer
              formRef={composerFormRef}
              promptInputRef={promptInputRef}
              composerDropActive={composerDropActive}
              onSubmit={onSendPrompt}
              onDragEnter={onComposerDragEnter}
              onDragOver={onComposerDragOver}
              onDragLeave={onComposerDragLeave}
              onDrop={onComposerDrop}
              activeThreadStatusCopy={activeThreadStatusCopy}
              activeThread={activeThread}
              activeThreadBusy={activeThreadBusy}
              activeThreadModelValue={activeThreadModelValue}
              hasSessionModelChoices={hasSessionModelChoices}
              sessionModelChoices={sessionModelChoices}
              sessionModelDefault={sessionModelDefault}
              onSetThreadModel={(modelName) => {
                if (!activeThread) return;
                setThreadModel(activeThread.id, modelName);
              }}
              onSetThreadSandbox={(value) => {
                if (!activeThread) return;
                setThreadSandbox(activeThread.id, value);
              }}
              onForkSession={() => {
                void onForkActiveSession();
              }}
              sessionAdvancedOpen={sessionAdvancedOpen}
              onToggleSessionAdvanced={() =>
                setSessionAdvancedOpen((prev) => !prev)}
              approvalPolicyOptions={APPROVAL_POLICY_OPTIONS}
              onSetThreadApprovalPolicy={(value) => {
                if (!activeThread) return;
                setThreadApprovalPolicy(activeThread.id, value);
              }}
              onSetThreadWebSearch={(next) => {
                if (!activeThread) return;
                setThreadWebSearch(activeThread.id, next);
              }}
              onSetThreadProfile={(value) => {
                if (!activeThread) return;
                setThreadProfile(activeThread.id, value);
              }}
              configFlagDraft={configFlagDraft}
              onConfigFlagDraftChange={setConfigFlagDraft}
              onConfigFlagDraftSubmit={onConfigFlagDraftSubmit}
              onRemoveConfigFlag={(value) => {
                if (!activeThread) return;
                removeThreadConfigFlag(activeThread.id, value);
              }}
              enableFlagDraft={enableFlagDraft}
              onEnableFlagDraftChange={setEnableFlagDraft}
              onEnableFlagDraftSubmit={onEnableFlagDraftSubmit}
              onRemoveEnableFlag={(value) => {
                if (!activeThread) return;
                removeThreadEnableFlag(activeThread.id, value);
              }}
              disableFlagDraft={disableFlagDraft}
              onDisableFlagDraftChange={setDisableFlagDraft}
              onDisableFlagDraftSubmit={onDisableFlagDraftSubmit}
              onRemoveDisableFlag={(value) => {
                if (!activeThread) return;
                removeThreadDisableFlag(activeThread.id, value);
              }}
              addDirDraft={addDirDraft}
              onAddDirDraftChange={setAddDirDraft}
              onAddDirDraftSubmit={onAddDirDraftSubmit}
              onRemoveAddDir={(value) => {
                if (!activeThread) return;
                removeThreadAddDir(activeThread.id, value);
              }}
              onSetThreadSkipGitRepoCheck={(next) => {
                if (!activeThread) return;
                setThreadSkipGitRepoCheck(activeThread.id, next);
              }}
              onSetThreadJSONOutput={(next) => {
                if (!activeThread) return;
                setThreadJSONOutput(activeThread.id, next);
              }}
              onSetThreadEphemeral={(next) => {
                if (!activeThread) return;
                setThreadEphemeral(activeThread.id, next);
              }}
              uploadingImage={uploadingImage}
              imageUploadError={imageUploadError}
              onUploadImage={(file, threadID) => {
                void onUploadSessionImage(file, threadID);
              }}
              onRemoveImagePath={(imagePath) => {
                if (!activeThread) return;
                removeThreadImagePath(activeThread.id, imagePath);
              }}
              activeDraft={activeDraft}
              onDraftChange={(value) => {
                if (!activeThread) return;
                updateThreadDraft(activeThread.id, value);
              }}
              onComposerPaste={onComposerPaste}
              activeThreadRunID={activeThreadRunID}
              cancelingThreadID={cancelingThreadID}
              onStopRun={() => {
                void onStopActiveSessionRun();
              }}
              hasRegeneratePrompt={hasRegeneratePrompt}
              onRegenerate={() => {
                void onRegenerateActiveSession();
              }}
            />
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
                  <input
                    type="checkbox"
                    checked={allHosts}
                    onChange={(event) => setAllHosts(event.target.checked)}
                  />
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
                          checked={
                            allHosts || selectedHostIDs.includes(host.id)
                          }
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
                        <button
                          type="button"
                          className="ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => void onProbeHost(host)}
                        >
                          {opsHostBusyID === host.id ? "..." : "Probe"}
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={opsHostBusyID === host.id}
                          onClick={() => onStartEditHost(host)}
                        >
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
                <select
                  value={selectedRuntime}
                  onChange={(event) => setSelectedRuntime(event.target.value)}
                >
                  {runtimes.map((runtime) => (
                    <option key={runtime.name} value={runtime.name}>
                      {runtime.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                sandbox
                <select
                  value={runSandbox}
                  onChange={(event) =>
                    setRunSandbox(
                      event.target.value as
                        | ""
                        | "read-only"
                        | "workspace-write"
                        | "danger-full-access",
                    )
                  }
                >
                  <option value="">default</option>
                  <option value="read-only">read-only</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
              </label>
              <label className="switch-inline">
                <input
                  type="checkbox"
                  checked={runAsyncMode}
                  onChange={(event) => setRunAsyncMode(event.target.checked)}
                />
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
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void onRefreshWorkspace()}
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh Queue"}
                </button>
                <button
                  type="button"
                  className="ghost danger-ghost"
                  disabled={!activeJob || !isJobActive(activeJob)}
                  onClick={() =>
                    activeJob ? void onCancelJob(activeJob) : undefined
                  }
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
                <li>
                  workers={metrics?.queue.workers_active ?? "-"}/
                  {metrics?.queue.workers_total ?? "-"}
                </li>
                <li>threads={threads.length}</li>
              </ul>
            </section>

            {opsNotice ? (
              <section
                className={`pane-block ops-notice ${opsNoticeIsError ? "ops-notice-error" : ""}`}
              >
                <h3>Ops Notice</h3>
                <p>{opsNotice}</p>
              </section>
            ) : null}
          </aside>

          <aside className="inspect-pane">
            {isRefreshing ? (
              <section className="inspect-block">
                <h3>Loading</h3>
                <p className="pane-subtle-light">
                  Refreshing hosts, queue, runs, and audit timeline...
                </p>
              </section>
            ) : null}

            <section className="inspect-block codex-platform-block">
              <h3>Codex Platform</h3>
              <label>
                target host
                <select
                  data-testid="platform-host-select"
                  value={platformHostID}
                  onChange={(event) => setPlatformHostID(event.target.value)}
                  disabled={hosts.length === 0 || platformBusySection !== ""}
                >
                  {hosts.length === 0 ? (
                    <option value="">no host</option>
                  ) : (
                    hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              {platformNotice ? (
                <p className="pane-subtle-light platform-notice">
                  {platformNotice}
                </p>
              ) : null}
              <div className="platform-grid">
                <article className="platform-card">
                  <h4>Auth</h4>
                  <div className="platform-actions-row">
                    <button
                      type="button"
                      className="ghost"
                      data-testid="platform-login-status-btn"
                      onClick={() => void onRunPlatformLogin("status")}
                      disabled={platformBusySection !== "" || !platformHostID}
                    >
                      Status
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      data-testid="platform-login-device-btn"
                      onClick={() => void onRunPlatformLogin("login_device")}
                      disabled={platformBusySection !== "" || !platformHostID}
                    >
                      Device Login
                    </button>
                    <button
                      type="button"
                      className="ghost danger-ghost"
                      data-testid="platform-logout-btn"
                      onClick={() => void onRunPlatformLogin("logout")}
                      disabled={platformBusySection !== "" || !platformHostID}
                    >
                      Logout
                    </button>
                  </div>
                  <pre
                    className="platform-output"
                    data-testid="platform-login-output"
                  >
                    {formatCodexPlatformResult(platformLoginResult)}
                  </pre>
                </article>

                <article className="platform-card">
                  <h4>MCP</h4>
                  <label>
                    action
                    <select
                      data-testid="platform-mcp-action-select"
                      value={platformMCPAction}
                      onChange={(event) =>
                        setPlatformMCPAction(
                          event.target.value as CodexPlatformMCPAction,
                        )
                      }
                      disabled={platformBusySection !== ""}
                    >
                      {CODEX_PLATFORM_MCP_ACTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {platformMCPAction === "get" ||
                  platformMCPAction === "add" ||
                  platformMCPAction === "remove" ||
                  platformMCPAction === "login" ||
                  platformMCPAction === "logout" ? (
                    <input
                      data-testid="platform-mcp-name-input"
                      placeholder="server name"
                      value={platformMCPName}
                      onChange={(event) => setPlatformMCPName(event.target.value)}
                      disabled={platformBusySection !== ""}
                    />
                  ) : null}
                  {platformMCPAction === "add" ? (
                    <>
                      <input
                        data-testid="platform-mcp-url-input"
                        placeholder="url (for streamable server)"
                        value={platformMCPURL}
                        onChange={(event) => setPlatformMCPURL(event.target.value)}
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-mcp-command-input"
                        placeholder="stdio command (space separated)"
                        value={platformMCPCommand}
                        onChange={(event) =>
                          setPlatformMCPCommand(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-mcp-env-input"
                        placeholder="env KEY=VALUE,KEY2=VALUE2"
                        value={platformMCPEnvCSV}
                        onChange={(event) => setPlatformMCPEnvCSV(event.target.value)}
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-mcp-bearer-env-input"
                        placeholder="bearer token env var"
                        value={platformMCPBearerTokenEnvVar}
                        onChange={(event) =>
                          setPlatformMCPBearerTokenEnvVar(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                    </>
                  ) : null}
                  {platformMCPAction === "login" ? (
                    <input
                      data-testid="platform-mcp-scopes-input"
                      placeholder="scopes (comma separated)"
                      value={platformMCPScopeCSV}
                      onChange={(event) => setPlatformMCPScopeCSV(event.target.value)}
                      disabled={platformBusySection !== ""}
                    />
                  ) : null}
                  <div className="platform-actions-row">
                    <button
                      type="button"
                      className="ghost"
                      data-testid="platform-mcp-run-btn"
                      onClick={() => void onRunPlatformMCP()}
                      disabled={platformBusySection !== "" || !platformHostID}
                    >
                      Run MCP
                    </button>
                  </div>
                  <pre className="platform-output" data-testid="platform-mcp-output">
                    {formatCodexPlatformResult(platformMCPResult)}
                  </pre>
                </article>

                <article className="platform-card">
                  <h4>Cloud</h4>
                  <label>
                    action
                    <select
                      data-testid="platform-cloud-action-select"
                      value={platformCloudAction}
                      onChange={(event) =>
                        setPlatformCloudAction(
                          event.target.value as CodexPlatformCloudAction,
                        )
                      }
                      disabled={platformBusySection !== ""}
                    >
                      {CODEX_PLATFORM_CLOUD_ACTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {platformCloudAction === "status" ||
                  platformCloudAction === "diff" ||
                  platformCloudAction === "apply" ? (
                    <input
                      data-testid="platform-cloud-task-id-input"
                      placeholder="task id"
                      value={platformCloudTaskID}
                      onChange={(event) =>
                        setPlatformCloudTaskID(event.target.value)
                      }
                      disabled={platformBusySection !== ""}
                    />
                  ) : null}
                  {platformCloudAction === "exec" ? (
                    <>
                      <input
                        data-testid="platform-cloud-env-id-input"
                        placeholder="env id"
                        value={platformCloudEnvID}
                        onChange={(event) =>
                          setPlatformCloudEnvID(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-cloud-query-input"
                        placeholder="query"
                        value={platformCloudQuery}
                        onChange={(event) =>
                          setPlatformCloudQuery(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-cloud-attempts-input"
                        placeholder="attempts"
                        value={platformCloudAttempts}
                        onChange={(event) =>
                          setPlatformCloudAttempts(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-cloud-branch-input"
                        placeholder="branch"
                        value={platformCloudBranch}
                        onChange={(event) =>
                          setPlatformCloudBranch(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                    </>
                  ) : null}
                  {platformCloudAction === "list" ? (
                    <>
                      <input
                        data-testid="platform-cloud-list-env-input"
                        placeholder="env id (optional)"
                        value={platformCloudEnvID}
                        onChange={(event) =>
                          setPlatformCloudEnvID(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-cloud-limit-input"
                        placeholder="limit"
                        value={platformCloudLimit}
                        onChange={(event) =>
                          setPlatformCloudLimit(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                      <input
                        data-testid="platform-cloud-cursor-input"
                        placeholder="cursor"
                        value={platformCloudCursor}
                        onChange={(event) =>
                          setPlatformCloudCursor(event.target.value)
                        }
                        disabled={platformBusySection !== ""}
                      />
                    </>
                  ) : null}
                  {platformCloudAction === "diff" ||
                  platformCloudAction === "apply" ? (
                    <input
                      data-testid="platform-cloud-attempt-input"
                      placeholder="attempt (optional)"
                      value={platformCloudAttempt}
                      onChange={(event) =>
                        setPlatformCloudAttempt(event.target.value)
                      }
                      disabled={platformBusySection !== ""}
                    />
                  ) : null}
                  <div className="platform-actions-row">
                    <button
                      type="button"
                      className="ghost"
                      data-testid="platform-cloud-run-btn"
                      onClick={() => void onRunPlatformCloud()}
                      disabled={platformBusySection !== "" || !platformHostID}
                    >
                      Run Cloud
                    </button>
                  </div>
                  <pre
                    className="platform-output"
                    data-testid="platform-cloud-output"
                  >
                    {formatCodexPlatformResult(platformCloudResult)}
                  </pre>
                </article>
              </div>
            </section>

            <section className="inspect-block">
              <h3>Active Job</h3>
              {activeJob ? (
                <div className="job-card">
                  <div className="job-head">
                    <strong>{activeJob.id}</strong>
                    <span className={`tone-${statusTone(activeJob.status)}`}>
                      {activeJob.status}
                    </span>
                  </div>
                  <p>runtime={activeJob.runtime}</p>
                  <p>thread={activeJobThreadID}</p>
                  <p>queued={formatDateTime(activeJob.queued_at)}</p>
                  <p>
                    hosts total={activeJob.total_hosts ?? 0} ok=
                    {activeJob.succeeded_hosts ?? 0} failed=
                    {activeJob.failed_hosts ?? 0}
                  </p>
                  <div className="progress-track" aria-label="job progress">
                    <span style={{ width: `${activeProgress}%` }} />
                  </div>
                  <p>http={activeJob.result_status ?? "n/a"}</p>
                  {activeJob.error ? (
                    <p className="tone-err">{activeJob.error}</p>
                  ) : null}
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
                        event.target.value as
                          | "all"
                          | "pending"
                          | "running"
                          | "succeeded"
                          | "failed"
                          | "canceled",
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
                  <select
                    value={opsJobTypeFilter}
                    onChange={(event) =>
                      setOpsJobTypeFilter(
                        event.target.value as "all" | "run" | "sync",
                      )
                    }
                  >
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
                        <span className={`tone-${statusTone(job.status)}`}>
                          {job.status}
                        </span>
                        <span>{job.type}</span>
                      </div>
                      <div className="history-item-actions">
                        {isJobActive(job) ? (
                          <button
                            type="button"
                            className="ghost danger-ghost"
                            onClick={() => void onCancelJob(job)}
                          >
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
                  <select
                    value={opsRunStatusFilter}
                    onChange={(event) =>
                      setOpsRunStatusFilter(
                        event.target.value as "all" | "ok" | "error",
                      )
                    }
                  >
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
                      <span
                        className={`tone-${run.status_code < 400 ? "ok" : "err"}`}
                      >
                        {run.status_code < 400
                          ? "ok"
                          : `http_${run.status_code}`}
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
                    onChange={(event) =>
                      setOpsAuditMethodFilter(
                        event.target.value as "all" | "GET" | "POST" | "DELETE",
                      )
                    }
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
                    onChange={(event) =>
                      setOpsAuditStatusFilter(
                        event.target.value as "all" | "2xx" | "4xx" | "5xx",
                      )
                    }
                  >
                    <option value="all">all</option>
                    <option value="2xx">2xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                  </select>
                </label>
              </div>
              {filteredAuditEvents.length === 0 ? (
                <p className="pane-subtle-light">
                  No audit events with current filters.
                </p>
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
                      <span
                        className={`tone-${evt.status_code < 400 ? "ok" : "err"}`}
                      >
                        {evt.status_code}
                      </span>
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
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                />
                <label>
                  connection mode
                  <select
                    value={hostForm.connectionMode}
                    onChange={(event) =>
                      setHostForm((prev) => ({
                        ...prev,
                        connectionMode: event.target.value as "ssh" | "local",
                      }))
                    }
                  >
                    <option value="ssh">ssh</option>
                    <option value="local">local</option>
                  </select>
                </label>
                <input
                  placeholder={
                    hostForm.connectionMode === "local"
                      ? "host (optional for local mode)"
                      : "host"
                  }
                  value={hostForm.host}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      host: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="user"
                  value={hostForm.user}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      user: event.target.value,
                    }))
                  }
                />
                <input
                  placeholder="workspace"
                  value={hostForm.workspace}
                  onChange={(event) =>
                    setHostForm((prev) => ({
                      ...prev,
                      workspace: event.target.value,
                    }))
                  }
                />
                <div className="ops-actions-row">
                  <button type="submit" disabled={addingHost}>
                    {addingHost
                      ? "Saving..."
                      : editingHostID
                        ? "Update Host"
                        : "Save Host"}
                  </button>
                  {editingHostID ? (
                    <button
                      type="button"
                      className="ghost"
                      onClick={onCancelHostEdit}
                    >
                      Cancel Edit
                    </button>
                  ) : null}
                </div>
              </form>
            </section>
          </aside>
        </div>
      )}

      <CommandPalette
        open={commandPaletteOpen && appMode === "session"}
        inputRef={commandPaletteInputRef}
        query={commandPaletteQuery}
        cursor={commandPaletteCursor}
        actions={filteredCommandPaletteActions}
        onClose={closeCommandPalette}
        onQueryChange={onCommandPaletteQueryChange}
        onKeyDown={onCommandPaletteKeyDown}
        onHoverAction={setCommandPaletteCursor}
        onRunAction={runCommandPaletteAction}
      />

    </div>
  );
}
