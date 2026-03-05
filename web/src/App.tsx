import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  API_BASE,
  archiveCodexV2Session,
  cancelRunJob,
  codexPlatformCloud,
  codexPlatformLogin,
  codexPlatformMCP,
  discoverCodexSessions,
  discoverCodexModels,
  deleteProject,
  deleteHost,
  forkCodexV2Session,
  getMetrics,
  getRunJob,
  healthz,
  interruptCodexV2Turn,
  listAudit,
  listHosts,
  listProjects,
  listRunJobEvents,
  listRunJobs,
  listRuns,
  listRuntimes,
  listSessions,
  probeHost,
  startCodexV2Session,
  startCodexV2Turn,
  uploadImage,
  upsertHost,
  upsertProject,
  type Host,
  type SessionRecord,
  type SessionStreamFrame,
  type RunJobEvent,
  type RunJobRecord,
  type CodexPlatformResult,
} from "./api";
import { useOpsDomain } from "./domains/ops";
import {
  clearStoredToken,
  loadStoredToken,
  storeToken,
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
import { useSessionStreamHealth } from "./features/session/use-session-stream-health";
import { useTimelineScrollController } from "./features/session/use-timeline-scroll";
import {
  buildDiscoveredProjects,
  buildProjectsFromRecords,
} from "./features/session/project-sync";
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
  EMPTY_ASSISTANT_FALLBACK,
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
  type SessionLastStatus,
  type SessionTreeHost,
  type SessionTreeProject,
} from "./features/session/types";
import {
  collectVisibleTreeSessionIDs,
  filterSessionTreeHosts,
  buildSessionTreeHosts,
} from "./features/session/tree";
import { runSessionStreamLoop } from "./features/session/stream-loop";
import { buildSessionStreamTargetIDs } from "./features/session/stream-targets";
import {
  extractThreadIDFromCodexSessionResponse,
  extractTurnIDFromPayload,
  parseCodexAssistantTextFromStdout,
  parseCodexSessionTitleFromStdout,
} from "./features/session/codex-parsing";
import { decodeSessionEventRecord } from "./features/session/session-events";
import {
  createSessionRunEventHandlers,
  ensureSessionRunState,
  surfaceRuntimeCardsFromRunState,
} from "./features/session/session-run-events";
import type {
  SessionRunStreamState,
  SessionStreamHealthState,
} from "./features/session/stream-types";
import {
  extractAssistantTextFromJob,
  formatClock,
  formatDateTime,
  isJobActive,
  jobHasTargetFailures,
  lastUserPromptFromTimeline,
  sessionCompletionCopy,
  summarizeTargetFailures,
} from "./features/session/runtime-utils";
import {
  dataTransferHasImage,
  firstImageFile,
  formatCodexPlatformResult,
  parseMessageSegments,
  shouldCollapseMessageBody,
  splitCSVValues,
  statusTone,
  streamHealthCopy,
  streamHealthTone,
} from "./features/session/view-helpers";
import {
  clipStreamText,
  deriveSessionTitleFromPrompt,
  isGenericSessionTitle,
  resolveProjectTitle,
} from "./features/session/utils";
type AuthPhase = "checking" | "locked" | "ready";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function isLocalDraftSessionID(sessionID: string): boolean {
  return /^session_\d+_\d+$/.test(sessionID.trim());
}

function appendCodexStdoutChunk(state: SessionRunStreamState, chunk: string) {
  if (!chunk) return;
  state.stdout = `${state.stdout}${chunk}`;
  if (state.stdout.length > 220000) {
    const trim = state.stdout.length - 220000;
    state.stdout = state.stdout.slice(trim);
    state.eventParseOffset = Math.max(0, state.eventParseOffset - trim);
  }
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
  const sessionStreamStateRef = useRef<
    Map<
      string,
      {
        controller: AbortController;
        ready: boolean;
        lastEventAt: number;
        suppressReplaySurface: boolean;
      }
    >
  >(new Map());
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
        void onForkActiveSession();
      },
      onTogglePinSession: setThreadPinned,
      onArchiveSession: () => {
        void onArchiveActiveSession();
      },
      onReconnectStream: onReconnectActiveStream,
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

  async function ensureLocalCodexHost(
    authToken: string,
    currentHosts: Host[],
  ): Promise<Host[]> {
    if (currentHosts.some((host) => host.connection_mode === "local")) {
      return currentHosts;
    }
    await upsertHost(authToken, {
      name: "local-default",
      connection_mode: "local",
      host: "localhost",
      workspace: activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
    });
    return listHosts(authToken);
  }

  async function refreshProjectsFromDiscovery(
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) {
    if (!discoverEnabled) {
      setSourceProjectIDs([]);
      syncProjectsFromDiscovery(
        buildDiscoveredProjects(sourceHosts, [], DEFAULT_WORKSPACE_PATH),
        {
        source: "discovery",
        },
      );
      return;
    }
    try {
      const discovered = await discoverCodexSessions(authToken, {
        all_hosts: true,
        fanout: Math.max(1, Math.min(8, sourceHosts.length || 1)),
        limit_per_host: 120,
      });
      setSourceProjectIDs([]);
      syncProjectsFromDiscovery(
        buildDiscoveredProjects(
          sourceHosts,
          discovered.body.targets ?? [],
          DEFAULT_WORKSPACE_PATH,
        ),
        { source: "discovery" },
      );
    } catch {
      setSourceProjectIDs([]);
      if (!preserveOnError) {
        syncProjectsFromDiscovery(
          buildDiscoveredProjects(sourceHosts, [], DEFAULT_WORKSPACE_PATH),
          {
            source: "discovery",
          },
        );
      }
    }
  }

  async function refreshProjectsFromSource(
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError = true,
  ) {
    const normalizeLastStatus = (raw: string | undefined): SessionLastStatus => {
      const value = (raw ?? "").trim().toLowerCase();
      if (value === "running" || value === "pending") return "running";
      if (value === "succeeded") return "succeeded";
      if (value === "failed") return "failed";
      if (value === "canceled") return "canceled";
      return "idle";
    };
    const reconcileFromSessionRecords = (records: SessionRecord[]) => {
      const currentByID = new Map<
        string,
        { activeJobID: string; lastJobStatus: SessionLastStatus }
      >();
      for (const workspace of workspaces) {
        for (const thread of workspace.sessions) {
          currentByID.set(thread.id, {
            activeJobID: thread.activeJobID.trim(),
            lastJobStatus: thread.lastJobStatus,
          });
        }
      }

      for (const record of records) {
        const sessionID = record.id.trim();
        if (!sessionID) continue;
        const current = currentByID.get(sessionID);
        if (!current) continue;
        const nextStatus = normalizeLastStatus(record.last_status);
        const nextJobID =
          nextStatus === "running"
            ? record.last_run_id?.trim() || current.activeJobID
            : "";
        if (
          current.activeJobID === nextJobID &&
          current.lastJobStatus === nextStatus
        ) {
          continue;
        }
        setThreadJobState(sessionID, nextJobID, nextStatus);
      }
    };

    try {
      const [projects, sessions] = await Promise.all([
        listProjects(authToken, 600, { runtime: "codex" }),
        listSessions(authToken, 1200, { runtime: "codex" }),
      ]);
      setSourceProjectIDs(
        projects
          .map((project) => project.id.trim())
          .filter((id) => id !== ""),
      );
      const built = buildProjectsFromRecords(
        sourceHosts,
        projects,
        sessions,
        DEFAULT_WORKSPACE_PATH,
      );
      const hasSessionItems = built.some((project) => project.sessions.length > 0);
      if (!hasSessionItems && discoverEnabled) {
        throw new Error("empty session snapshot");
      }
      // Server snapshot is authoritative for project/session membership.
      syncProjectsFromServer(built);
      reconcileFromSessionRecords(sessions);
      return;
    } catch {
      setSourceProjectIDs([]);
      // fall through to discovery fallback
    }
    await refreshProjectsFromDiscovery(
      authToken,
      sourceHosts,
      discoverEnabled,
      preserveOnError,
    );
  }

  function stopSessionStream(
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) {
    const state = sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    state.controller.abort();
    sessionStreamStateRef.current.delete(sessionID);
    sessionEventQueueRef.current.delete(sessionID);
    if (!options?.preserveRunState) {
      sessionRunStateRef.current.delete(sessionID);
    }
    if (!options?.preserveHealth) {
      clearSessionStreamHealth(sessionID);
    }
  }

  function stopAllSessionStreams() {
    for (const state of sessionStreamStateRef.current.values()) {
      state.controller.abort();
    }
    sessionStreamStateRef.current.clear();
    sessionEventQueueRef.current.clear();
    sessionRunStateRef.current.clear();
    clearAllSessionStreamHealth();
  }

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

  function handleSessionStreamFrame(
    sessionID: string,
    frame: SessionStreamFrame,
  ) {
    const state = sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    const receivedAt = Date.now();
    state.lastEventAt = receivedAt;

    if (frame.event === "session.ready") {
      state.ready = true;
      state.suppressReplaySurface = false;
      updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
        lastError: "",
      });
      const data = asRecord(frame.data);
      const cursor = data ? Number(data.cursor) : NaN;
      if (Number.isFinite(cursor)) {
        setSessionEventCursor(sessionID, cursor);
      }
      return;
    }

    if (frame.event === "session.reset") {
      state.ready = false;
      updateSessionStreamHealth(sessionID, "reconnecting", {
        lastEventAt: receivedAt,
        throttleMS: 0,
      });
      const data = asRecord(frame.data);
      const nextAfter = data ? Number(data.next_after) : NaN;
      state.suppressReplaySurface = !(Number.isFinite(nextAfter) && nextAfter > 0);
      if (Number.isFinite(nextAfter)) {
        setSessionEventCursor(sessionID, nextAfter);
      }
      return;
    }

    if (frame.event === "heartbeat") {
      updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
      });
      return;
    }

    if (frame.event !== "session.event") {
      return;
    }

    updateSessionStreamHealth(sessionID, "live", {
      lastEventAt: receivedAt,
      lastError: "",
    });
    const event = decodeSessionEventRecord(frame.data);
    if (!event) return;

    const current = sessionEventCursorRef.current.get(sessionID) ?? 0;
    if (event.seq <= current) return;
    setSessionEventCursor(sessionID, event.seq);
    const surfaceByReplay = !state.suppressReplaySurface;
    const surfaceCompletions = state.ready || surfaceByReplay;
    const surfaceLifecycle = state.ready || surfaceByReplay;
    const previousQueue =
      sessionEventQueueRef.current.get(sessionID) ?? Promise.resolve();
    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(() =>
        handleSessionEventRecord(sessionID, event, {
          surfaceCompletions,
          surfaceLifecycle,
        }),
      )
      .catch(() => undefined);
    sessionEventQueueRef.current.set(sessionID, nextQueue);
    void nextQueue.finally(() => {
      const currentQueue = sessionEventQueueRef.current.get(sessionID);
      if (currentQueue !== nextQueue) return;
      sessionEventQueueRef.current.delete(sessionID);
    });
  }

  function startSessionStream(sessionID: string, authToken: string) {
    const trimmedSessionID = sessionID.trim();
    if (!trimmedSessionID) return;
    if (sessionStreamStateRef.current.has(trimmedSessionID)) return;

    const controller = new AbortController();
    sessionStreamStateRef.current.set(trimmedSessionID, {
      controller,
      ready: false,
      lastEventAt: 0,
      suppressReplaySurface: true,
    });
    updateSessionStreamHealth(trimmedSessionID, "connecting", {
      retries: 0,
      lastEventAt: 0,
      lastError: "",
      throttleMS: 0,
    });
    void runSessionStreamLoop({
      authToken,
      sessionID: trimmedSessionID,
      controller,
      getAfter: () => sessionEventCursorRef.current.get(trimmedSessionID) ?? 0,
      setSuppressReplaySurface: (value) => {
        const streamState = sessionStreamStateRef.current.get(trimmedSessionID);
        if (streamState && streamState.controller === controller) {
          streamState.suppressReplaySurface = value;
        }
      },
      onFrame: (frame) => handleSessionStreamFrame(trimmedSessionID, frame),
      isRunningSession: () => runningSessionIDsRef.current.has(trimmedSessionID),
      onState: (state, options) => {
        const active = sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        updateSessionStreamHealth(trimmedSessionID, state, {
          retries: options?.retries,
          lastError: options?.lastError,
          throttleMS: 0,
        });
      },
      onBeforeBackoff: () => {
        const active = sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        active.ready = false;
      },
      onFinalize: () => {
        const active = sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        sessionStreamStateRef.current.delete(trimmedSessionID);
        sessionEventQueueRef.current.delete(trimmedSessionID);
      },
    });
  }

  async function loadWorkspace(authToken: string) {
    const refreshStartedAtMS = Date.now();
    setIsRefreshing(true);
    try {
      const [
        healthBody,
        fetchedHosts,
        nextRuntimes,
        nextJobs,
        nextRuns,
        nextAudit,
        nextMetrics,
      ] = await Promise.all([
        healthz(),
        listHosts(authToken),
        listRuntimes(authToken),
        listRunJobs(authToken, 20),
        listRuns(authToken, 20),
        listAudit(authToken, 80),
        getMetrics(authToken),
      ]);
      const nextHosts = await ensureLocalCodexHost(authToken, fetchedHosts);

      setHealth(`ok ${healthBody.timestamp}`);
      setHosts(nextHosts);
      setRuntimes(nextRuntimes);
      setJobs(nextJobs);
      setRuns(nextRuns);
      setAuditEvents(nextAudit);
      setMetrics(nextMetrics);

      const localHost = nextHosts.find(
        (host) => host.connection_mode === "local",
      );
      if (localHost) {
        setAllHosts(false);
        setSelectedHostIDs([localHost.id]);
      } else {
        setSelectedHostIDs((prev) => {
          const nextSelected = prev.filter((id) =>
            nextHosts.some((host) => host.id === id),
          );
          if (nextSelected.length > 0) return nextSelected;
          if (nextHosts.length > 0) return [nextHosts[0].id];
          return [];
        });
      }
      const codexRuntime = nextRuntimes.find(
        (runtime) => runtime.name === "codex",
      );
      if (codexRuntime) {
        setSelectedRuntime("codex");
      } else if (
        !nextRuntimes.some((runtime) => runtime.name === selectedRuntime)
      ) {
        setSelectedRuntime(nextRuntimes[0]?.name ?? "codex");
      }
      await refreshProjectsFromSource(
        authToken,
        nextHosts,
        nextRuntimes.some((runtime) => runtime.name === "codex"),
        workspaces.length > 0,
      );

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
        if (!jobStreamSeenRef.current.has(job.id)) {
          jobStreamSeenRef.current.set(job.id, false);
        }
      }
      // Only surface completion alerts for events that happen after this sync starts.
      completionAlertCutoffMSRef.current = refreshStartedAtMS;
    } catch (error) {
      setHealth(`error: ${String(error)}`);
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
      storeToken(trimmed);
      setToken(trimmed);
      setTokenInput(trimmed);
      await loadWorkspace(trimmed);
      setAuthPhase("ready");
    } catch (error) {
      clearStoredToken();
      setToken("");
      setAuthPhase("locked");
      setAuthError(`token validation failed: ${String(error)}`);
    }
  }

  useEffect(() => {
    const cached = loadStoredToken();
    if (!cached.trim()) {
      setAuthPhase("locked");
      return;
    }
    void unlockWorkspace(cached);
  }, []);

  useEffect(() => {
    const ready = authPhase === "ready" && token.trim() !== "";
    if (!ready) {
      streamAuthTokenRef.current = "";
      stopAllSessionStreams();
      return;
    }
    if (streamAuthTokenRef.current !== token) {
      stopAllSessionStreams();
      streamAuthTokenRef.current = token;
    }

    const expected = new Set(sessionStreamTargetIDs);
    for (const sessionID of expected) {
      if (!sessionStreamStateRef.current.has(sessionID)) {
        startSessionStream(sessionID, token);
      }
    }
    for (const sessionID of Array.from(sessionStreamStateRef.current.keys())) {
      if (expected.has(sessionID)) continue;
      stopSessionStream(sessionID);
    }
  }, [authPhase, token, sessionStreamTargetIDs]);

  useEffect(() => {
    return () => {
      stopAllSessionStreams();
    };
  }, []);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (!activeSessionHostID) return;
    if (!runtimes.some((runtime) => runtime.name === "codex")) return;
    let canceled = false;
    void discoverCodexModels(token, { host_id: activeSessionHostID })
      .then((catalog) => {
        if (canceled) return;
        const nextDefault = catalog.default_model?.trim() || "";
        const nextModels = Array.isArray(catalog.models)
          ? catalog.models.filter((name) => name.trim() !== "")
          : [];
        setSessionModelDefault(nextDefault);
        setSessionModelOptions(nextModels);
      })
      .catch(() => {
        if (canceled) return;
        setSessionModelDefault("");
        setSessionModelOptions([]);
      });
    return () => {
      canceled = true;
    };
  }, [authPhase, token, activeSessionHostID, runtimes]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (appMode !== "session") return;
    if (!runtimes.some((runtime) => runtime.name === "codex")) return;
    if (hosts.length === 0) return;
    if (runningThreadJobs.length > 0 || submittingThreadID !== "") return;

    let canceled = false;
    const refresh = async () => {
      try {
        await refreshProjectsFromSource(token, hosts, true, true);
      } catch {
        // no-op: best-effort title/session sync
      }
    };

    const timer = window.setInterval(() => {
      if (canceled) return;
      void refresh();
    }, 25000);

    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [
    authPhase,
    token,
    appMode,
    hosts,
    runtimes,
    runningThreadJobs.length,
    submittingThreadID,
  ]);

  useEffect(() => {
    if (appMode !== "session" || authPhase !== "ready" || !token.trim()) return;
    const activeRunID = activeThread?.activeJobID?.trim() ?? "";
    if (!activeRunID || !knownJobIDSet.has(activeRunID)) {
      setActiveJobID("");
      setActiveJob(null);
      return;
    }
    void getRunJob(token, activeRunID)
      .then((job) => {
        setActiveJobID(job.id);
        setActiveJob(job);
      })
      .catch(() => {
        setActiveJobID("");
        setActiveJob(null);
      });
  }, [appMode, authPhase, token, activeThread?.id, activeThread?.activeJobID, knownJobIDSet]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim()) return;
    if (runningJobPollTargets.length === 0) return;

    let canceled = false;
    const poll = async () => {
      const pollingJobs = runningJobPollTargets;
      if (pollingJobs.length === 0) return;
      try {
        const jobResults = await Promise.all(
          pollingJobs.map(async (item) => {
            try {
              const after = jobEventCursorRef.current.get(item.jobID) ?? 0;
              const [job, eventFeed] = await Promise.all([
                getRunJob(token, item.jobID),
                listRunJobEvents(token, item.jobID, after, 240).catch(() => ({
                  events: [] as RunJobEvent[],
                  next_after: after,
                })),
              ]);
              return {
                item,
                job,
                error: "",
                events: eventFeed.events,
                nextAfter: eventFeed.next_after,
              };
            } catch (error) {
              return {
                item,
                job: null as RunJobRecord | null,
                error: String(error),
                events: [] as RunJobEvent[],
                nextAfter: jobEventCursorRef.current.get(item.jobID) ?? 0,
              };
            }
          }),
        );
        if (canceled) return;

        let needsProjectRefresh = false;
        for (const result of jobResults) {
          const { item, job, error, events, nextAfter } = result;
          if (!job) {
            addTimelineEntry(
              {
                kind: "system",
                state: "error",
                title: "Session Update Failed",
                body: error,
              },
              item.threadID,
            );
            setThreadJobState(item.threadID, "", "failed");
            continue;
          }
          jobEventCursorRef.current.set(item.jobID, nextAfter);
          const alreadyCompleted = hasCompletedRun(item.jobID);
          const streamRunState = sessionRunStateRef.current.get(item.threadID);
          const preferSessionStream =
            streamRunState?.runID === item.jobID &&
            (streamRunState?.streamSeen || streamRunState?.assistantFinalized);

          let stdoutStream = "";
          const showLiveStream =
            !preferSessionStream &&
            appMode === "session" &&
            item.threadID === activeThreadID;
          const fallbackRunState =
            !preferSessionStream && job.runtime === "codex"
              ? ensureSessionRunState(
                  sessionRunStateRef,
                  item.threadID,
                  item.jobID,
                )
              : null;
          for (const event of events) {
            if (
              event.type === "target.stdout" &&
              typeof event.chunk === "string"
            ) {
              stdoutStream += event.chunk;
              if (fallbackRunState) {
                appendCodexStdoutChunk(fallbackRunState, event.chunk);
              }
            }
          }
          if (!alreadyCompleted && showLiveStream && fallbackRunState) {
            surfaceRuntimeCardsFromRunState(
              addTimelineEntry,
              item.threadID,
              item.jobID,
              fallbackRunState,
              true,
            );
          }
          if (!alreadyCompleted && showLiveStream && stdoutStream.trim()) {
            if (job.runtime === "codex") {
              const sourceStdout = fallbackRunState
                ? fallbackRunState.stdout
                : stdoutStream;
              const nextTitle = parseCodexSessionTitleFromStdout(sourceStdout);
              if (nextTitle) {
                setThreadTitle(item.threadID, nextTitle);
              }
              const contentOnly = parseCodexAssistantTextFromStdout(
                sourceStdout,
                false,
              );
              if (contentOnly.trim()) {
                jobStreamSeenRef.current.set(item.jobID, true);
                upsertAssistantStreamEntry(
                  item.threadID,
                  clipStreamText(contentOnly),
                );
              } else if (
                sourceStdout.includes('"type":"turn.started"') ||
                sourceStdout.includes('"type":"thread.started"')
              ) {
                jobStreamSeenRef.current.set(item.jobID, true);
              }
            } else {
              jobStreamSeenRef.current.set(item.jobID, true);
              upsertAssistantStreamEntry(
                item.threadID,
                clipStreamText(stdoutStream),
              );
            }
          }
          if (item.threadID === activeThreadID) {
            setActiveJob(job);
            setActiveJobID(job.id);
          }

          if (isJobActive(job)) {
            setThreadJobState(item.threadID, job.id, "running");
            continue;
          }

          const responseFailed = jobHasTargetFailures(job);
          const assistantText =
            job.status === "succeeded" ? extractAssistantTextFromJob(job) : "";
          if (
            job.runtime === "codex" &&
            job.status === "succeeded" &&
            !responseFailed &&
            !assistantText.trim()
          ) {
            const retries =
              jobNoTextFinalizeRetriesRef.current.get(job.id) ?? 0;
            if (retries < 4) {
              jobNoTextFinalizeRetriesRef.current.set(job.id, retries + 1);
              setThreadJobState(item.threadID, job.id, "running");
              continue;
            }
          } else {
            jobNoTextFinalizeRetriesRef.current.delete(job.id);
          }

          if (job.runtime === "codex") {
            needsProjectRefresh = true;
          }
          const terminalStatus =
            job.status === "failed" || job.status === "canceled"
              ? job.status
              : responseFailed
                ? "failed"
                : job.status === "succeeded"
                  ? "succeeded"
                  : "failed";
          const shouldSurfaceJobCompletion = shouldSurfaceCompletion(
            job.finished_at || job.started_at || job.queued_at,
          );
          setThreadJobState(item.threadID, "", terminalStatus);
          jobEventCursorRef.current.delete(item.jobID);
          jobNoTextFinalizeRetriesRef.current.delete(job.id);
          const pollRunState = sessionRunStateRef.current.get(item.threadID);
          if (!preferSessionStream && pollRunState?.runID === item.jobID) {
            sessionRunStateRef.current.delete(item.threadID);
          }
          const sawSessionStream =
            streamRunState?.runID === item.jobID &&
            (streamRunState.streamSeen || streamRunState.assistantFinalized);
          const sawJobStream = Boolean(jobStreamSeenRef.current.get(item.jobID));
          jobStreamSeenRef.current.delete(item.jobID);
          const sawAnyStream = Boolean(sawSessionStream || sawJobStream);
          if (shouldSurfaceJobCompletion && item.threadID !== activeThreadID) {
            setThreadUnread(item.threadID, true);
          }

          if (hasCompletedRun(job.id)) {
            if (job.status === "succeeded") {
              if (assistantText) {
                if (sawAnyStream) {
                  finalizeAssistantStreamEntry(
                    item.threadID,
                    "success",
                    assistantText,
                  );
                }
              } else if (sawAnyStream) {
                finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  EMPTY_ASSISTANT_FALLBACK,
                );
              }
            }
            continue;
          }

          markRunCompleted(job.id);
          {
            const failedSummary = summarizeTargetFailures(job);
            if (
              job.status === "failed" ||
              job.status === "canceled" ||
              responseFailed
            ) {
              if (sawAnyStream) {
                finalizeAssistantStreamEntry(item.threadID, "error");
              }
              addTimelineEntry(
                {
                  kind: "system",
                  state: "error",
                  title: job.status === "canceled" ? "Interrupted" : "Failed",
                  body:
                    failedSummary ||
                    (job.status === "canceled"
                      ? "Session interrupted."
                      : job.error
                        ? String(job.error)
                        : "Session failed."),
                },
                item.threadID,
              );
            } else if (assistantText) {
              if (sawAnyStream) {
                finalizeAssistantStreamEntry(
                  item.threadID,
                  "success",
                  assistantText,
                );
              } else {
                addTimelineEntry(
                  {
                    kind: "assistant",
                    state: "success",
                    title: "Assistant",
                    body: assistantText,
                  },
                  item.threadID,
                );
              }
            } else if (sawAnyStream) {
              finalizeAssistantStreamEntry(
                item.threadID,
                "success",
                EMPTY_ASSISTANT_FALLBACK,
              );
            }
            const sessionTitle =
              threadTitleMapRef.current.get(item.threadID) ?? "Session";
            const completionStatus: "succeeded" | "failed" | "canceled" =
              job.status === "canceled"
                ? "canceled"
                : job.status === "succeeded" && !responseFailed
                  ? "succeeded"
                  : "failed";
            const completion = sessionCompletionCopy(completionStatus);
            if (shouldSurfaceJobCompletion) {
              notifySessionDone(
                `${sessionTitle} ${completion.suffix}`,
                completion.body,
              );
              pushSessionAlert({
                threadID: item.threadID,
                title: `${sessionTitle} ${completion.suffix}`,
                body: completion.body,
              });
            }
          }
        }

        const [nextJobs, nextRuns, nextAudit, refreshedMetrics] =
          await Promise.all([
            listRunJobs(token, 20),
            listRuns(token, 20),
            listAudit(token, 80),
            getMetrics(token),
          ]);
        if (canceled) return;
        setJobs(nextJobs);
        setRuns(nextRuns);
        setAuditEvents(nextAudit);
        setMetrics(refreshedMetrics);
        if (needsProjectRefresh) {
          await refreshProjectsFromSource(
            token,
            hosts,
            runtimes.some((runtime) => runtime.name === "codex"),
            true,
          );
          if (canceled) return;
        }
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
  }, [
    authPhase,
    token,
    appMode,
    runningJobPollTargets,
    activeThreadID,
    hosts,
    runtimes,
  ]);

  useEffect(() => {
    if (authPhase !== "ready" || !token.trim() || appMode !== "ops") return;

    let canceled = false;
    const timer = window.setInterval(async () => {
      try {
        const [nextJobs, nextRuns, nextAudit, nextMetrics] = await Promise.all([
          listRunJobs(token, 20),
          listRuns(token, 20),
          listAudit(token, 80),
          getMetrics(token),
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

  async function onRefreshWorkspace() {
    if (authPhase !== "ready" || !token.trim()) return;
    await loadWorkspace(token);
  }

  async function onCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;
    const hostID = projectFormHostID.trim();
    const path = projectFormPath.trim();
    const title = projectFormTitle.trim();
    if (!hostID || !path) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Project Validation",
        body: "Server and project path are required.",
      });
      return;
    }

    setUpsertingProjectID("__create__");
    try {
      const saved = await upsertProject(token, {
        host_id: hostID,
        path,
        title: title || undefined,
        runtime: "codex",
      });
      await refreshProjectsFromSource(token, hosts, false, true);
      if (saved.id.trim()) {
        setActiveWorkspaceID(saved.id.trim());
      }
      closeProjectComposer();
      addTimelineEntry({
        kind: "system",
        state: "success",
        title: "Project Created",
        body: `${resolveProjectTitle(path, title)} · ${path}`,
      });
    } catch (error) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Create Project Failed",
        body: String(error),
      });
    } finally {
      setUpsertingProjectID("");
    }
  }

  async function onRenameProject(project: SessionTreeProject) {
    if (authPhase !== "ready" || !token.trim()) return;
    const currentTitle = resolveProjectTitle(project.path, project.title);
    const next = window.prompt("Project name", currentTitle);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Rename Project Failed",
        body: "Project name is required.",
      });
      return;
    }
    if (trimmed === currentTitle) return;

    setUpsertingProjectID(project.id);
    try {
      const saved = await upsertProject(token, {
        id: project.id,
        host_id: project.hostID,
        path: project.path,
        title: trimmed,
        runtime: "codex",
      });
      await refreshProjectsFromSource(token, hosts, false, true);
      if (saved.id.trim()) {
        setActiveWorkspaceID(saved.id.trim());
      }
      addTimelineEntry({
        kind: "system",
        state: "success",
        title: "Project Renamed",
        body: `${currentTitle} -> ${trimmed}`,
      });
    } catch (error) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Rename Project Failed",
        body: String(error),
      });
    } finally {
      setUpsertingProjectID("");
    }
  }

  async function onArchiveProject(
    projectID: string,
    projectHostID: string,
    projectPath: string,
    sessionCount: number,
  ) {
    if (authPhase !== "ready" || !token.trim()) return;
    const sourceProjectID = projectID.trim();
    const sourceHostID = projectHostID.trim();
    const sourcePath = projectPath.trim();
    const loadingKey = sourceProjectID;

    const confirmed = window.confirm(
      `Archive empty project "${sourcePath}"?`,
    );
    if (!confirmed) return;

    setDeletingProjectID(loadingKey);

    let targetProjectID = sourceProjectID;
    let remoteProjectResolved = sourceProjectIDSet.has(targetProjectID);
    try {
      if (!remoteProjectResolved) {
        try {
          const remoteProjects = await listProjects(token, 600, {
            runtime: "codex",
          });
          setSourceProjectIDs(
            remoteProjects
              .map((project) => project.id.trim())
              .filter((id) => id !== ""),
          );
          const matched =
            remoteProjects.find(
              (project) => project.id.trim() === sourceProjectID,
            ) ??
            remoteProjects.find(
              (project) =>
                project.host_id.trim() === sourceHostID &&
                project.path.trim() === sourcePath,
            );
          if (matched?.id?.trim()) {
            targetProjectID = matched.id.trim();
            remoteProjectResolved = true;
          }
        } catch {
          // no-op: keep fallback to local-only message below
        }
      }

      if (!remoteProjectResolved || !targetProjectID) {
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Archive Unavailable",
            body: "Project is local-only and cannot be archived remotely.",
          },
          activeThreadID,
        );
        return;
      }

      let resolvedSessionCount = sessionCount;
      try {
        const remoteSessions = await listSessions(token, 200, {
          project_id: targetProjectID,
          runtime: "codex",
        });
        resolvedSessionCount = remoteSessions.length;
      } catch {
        // fallback to current UI count
      }

      if (resolvedSessionCount > 0) {
        addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Archive Blocked",
            body:
              resolvedSessionCount === 1
                ? "Project still has 1 session. Archive it first."
                : `Project still has ${resolvedSessionCount} sessions. Archive them first.`,
          },
          activeThreadID,
        );
        return;
      }

      await deleteProject(token, targetProjectID);
      await refreshProjectsFromSource(token, hosts, false, true);
      addTimelineEntry(
        {
          kind: "system",
          state: "success",
          title: "Project Archived",
          body: projectPath,
        },
        activeThreadID,
      );
    } catch (error) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Project Archive Failed",
          body: String(error),
        },
        activeThreadID,
      );
    } finally {
      setDeletingProjectID("");
    }
  }

  async function onArchiveActiveSession() {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    const targetSessionID = activeThread.id.trim();
    if (!targetSessionID) return;
    if (activeThread.activeJobID || submittingThreadID === targetSessionID) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Archive Blocked",
          body: "Session is running. Stop it before archiving.",
        },
        targetSessionID,
      );
      return;
    }
    const confirmed = window.confirm(
      `Archive session "${activeThread.title}" on host "${activeWorkspace?.hostName || "unknown"}"?`,
    );
    if (!confirmed) return;
    if (isLocalDraftSessionID(targetSessionID)) {
      removeThread(targetSessionID);
      return;
    }

    setDeletingThreadID(targetSessionID);
    try {
      await archiveCodexV2Session(token, targetSessionID, {
        host_id: activeWorkspace?.hostID?.trim() || undefined,
      });
      stopSessionStream(targetSessionID);
      deleteSessionEventCursor(targetSessionID);
      sessionRunStateRef.current.delete(targetSessionID);
      removeThread(targetSessionID);
      await refreshProjectsFromSource(token, hosts, false, true);
    } catch (error) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Archive Failed",
          body: String(error),
        },
        targetSessionID,
      );
    } finally {
      setDeletingThreadID("");
    }
  }

  function onReconnectActiveStream() {
    if (authPhase !== "ready" || !token.trim()) return;
    const sessionID = activeThreadID.trim();
    if (!sessionID) return;
    stopSessionStream(sessionID, { preserveRunState: true, preserveHealth: true });
    updateSessionStreamHealth(sessionID, "connecting", {
      throttleMS: 0,
      lastError: "",
    });
    startSessionStream(sessionID, token);
  }

  async function submitPromptForActiveThread(trimmedPrompt: string) {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    if (activeThread.activeJobID || submittingThreadID === activeThread.id) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Session Busy",
          body: "This session is already running. Wait for completion or switch to another session.",
        },
        activeThread.id,
      );
      return;
    }

    const prompt = trimmedPrompt.trim();
    if (!prompt) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Prompt Missing",
          body: "Prompt is required.",
        },
        activeThread.id,
      );
      return;
    }
    if (isGenericSessionTitle(activeThread.title)) {
      const nextTitle = deriveSessionTitleFromPrompt(prompt);
      if (nextTitle) {
        setThreadTitle(activeThread.id, nextTitle);
      }
    }

    const workspaceHostID = activeWorkspace?.hostID?.trim() ?? "";
    const localHostIDs = hosts
      .filter((host) => host.connection_mode === "local")
      .map((host) => host.id);
    const targetHostIDs =
      workspaceHostID !== ""
        ? [workspaceHostID]
        : selectedHostIDs.length > 0
          ? selectedHostIDs
          : localHostIDs.length > 0
            ? localHostIDs
            : hosts.length > 0
              ? [hosts[0].id]
              : [];
    if (targetHostIDs.length === 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Server Available",
          body: "No server is available for this session.",
        },
        activeThread.id,
      );
      return;
    }

    const selectedHosts = hosts.filter((host) =>
      targetHostIDs.includes(host.id),
    );
    const hasNonLocalTarget = selectedHosts.some(
      (host) => host.connection_mode !== "local",
    );
    const safeImagePaths = !hasNonLocalTarget ? activeThread.imagePaths : [];
    if (hasNonLocalTarget && activeThread.imagePaths.length > 0) {
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Image Attachment Skipped",
          body: "Image attachments are only applied to local-mode targets.",
        },
        activeThread.id,
      );
    }

    const effectiveModel =
      activeThread.model.trim() ||
      sessionModelDefault.trim() ||
      sessionModelChoices[0]?.trim() ||
      undefined;
    const effectiveSandbox =
      activeThread.sandbox || runSandbox || "workspace-write";
    const effectiveWorkdir = activeWorkspace?.path.trim() || undefined;

    const runtimeName = activeRuntime?.name ?? selectedRuntime;
    if (runtimeName !== "codex") {
      throw new Error("Session mode only supports codex runtime.");
    }

    addTimelineEntry(
      {
        kind: "user",
        title: "You",
        body: prompt,
      },
      activeThread.id,
    );
    let targetThreadID = activeThread.id;
    forceStickToBottom();
    updateThreadDraft(activeThread.id, "");

    const normalizedStringList = (values: string[]): string[] | undefined => {
      if (!Array.isArray(values) || values.length === 0) return undefined;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
      }
      return out.length > 0 ? out : undefined;
    };

    setSubmittingThreadID(activeThread.id);
    try {
      const targetHostID = targetHostIDs[0]?.trim() ?? "";
      if (!targetHostID) {
        throw new Error("host_id is required for codex v2 session");
      }

      let sessionID = activeThread.id.trim();
      if (isLocalDraftSessionID(sessionID)) {
        const sessionResp = await startCodexV2Session(token, {
          host_id: targetHostID,
          path: effectiveWorkdir,
          title: activeThread.title,
          model: effectiveModel,
          approval_policy: activeThread.approvalPolicy || undefined,
          sandbox: effectiveSandbox,
        });
        const resolvedSessionID =
          extractThreadIDFromCodexSessionResponse(sessionResp) ||
          sessionResp.session.id.trim();
        if (!resolvedSessionID) {
          throw new Error("thread/start returned empty session id");
        }
        const previousSessionID = sessionID;
        sessionID = bindThreadID(previousSessionID, resolvedSessionID, {
          title: sessionResp.session.title,
        });
        targetThreadID = sessionID;
        if (previousSessionID !== sessionID) {
          stopSessionStream(previousSessionID, { preserveRunState: false, preserveHealth: false });
          deleteSessionEventCursor(previousSessionID);
          sessionRunStateRef.current.delete(previousSessionID);
        }
      }

      const turnInput: Array<Record<string, unknown>> = [
        { type: "text", text: prompt },
      ];
      for (const imagePath of safeImagePaths) {
        const trimmedPath = imagePath.trim();
        if (!trimmedPath) continue;
        turnInput.push({
          type: "input_image",
          image_url: trimmedPath,
        });
      }

      const turnResp = await startCodexV2Turn(token, sessionID, {
        host_id: targetHostID,
        input: turnInput,
        mode: activeThread.codexMode,
        resume_last: activeThread.resumeLast,
        resume_session_id: activeThread.resumeSessionID.trim() || undefined,
        review_uncommitted: activeThread.reviewUncommitted,
        review_base: activeThread.reviewBase.trim() || undefined,
        review_commit: activeThread.reviewCommit.trim() || undefined,
        review_title: activeThread.reviewTitle.trim() || undefined,
        model: effectiveModel,
        cwd: effectiveWorkdir,
        approval_policy: activeThread.approvalPolicy || undefined,
        sandbox: effectiveSandbox,
        search: activeThread.webSearch,
        profile: activeThread.profile.trim() || undefined,
        config: normalizedStringList(activeThread.configFlags),
        enable: normalizedStringList(activeThread.enableFlags),
        disable: normalizedStringList(activeThread.disableFlags),
        add_dirs: normalizedStringList(activeThread.addDirs),
        skip_git_repo_check: activeThread.skipGitRepoCheck,
        ephemeral: activeThread.ephemeral,
        json_output: activeThread.jsonOutput,
      });
      const turnID = extractTurnIDFromPayload(turnResp);
      const runID = turnID || `run_${Date.now()}`;
      ensureSessionRunState(sessionRunStateRef, sessionID, runID);
      setThreadJobState(sessionID, runID, "running");
      setActiveJobThreadID(sessionID);
      if (sessionID === activeThreadIDRef.current) {
        setActiveJobID(runID);
      }
      if (!sessionStreamStateRef.current.has(sessionID)) {
        startSessionStream(sessionID, token);
      }
      setSubmittingThreadID("");
      return;
    } catch (error) {
      finalizeAssistantStreamEntry(targetThreadID, "error");
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Response Failed",
          body: String(error),
        },
        targetThreadID,
      );
      setThreadJobState(targetThreadID, "", "failed");
      setSubmittingThreadID("");
    }
  }

  async function onSendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    const editorValue = promptInputRef.current?.value ?? "";
    const trimmedPrompt = activeThread.draft.trim() || editorValue.trim();
    await submitPromptForActiveThread(trimmedPrompt);
  }

  async function onStopActiveSessionRun() {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    const runID = activeThread.activeJobID.trim();
    if (!runID) return;
    if (cancelingThreadID === activeThread.id) return;
    setCancelingThreadID(activeThread.id);
    try {
      const runtimeName = activeRuntime?.name ?? selectedRuntime;
      if (runtimeName === "codex") {
        await interruptCodexV2Turn(token, activeThread.id, runID, {
          host_id: activeWorkspace?.hostID?.trim() || undefined,
        });
      } else {
        await cancelRunJob(token, runID);
      }
      addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Stopping",
          body: "Stopping current response...",
        },
        activeThread.id,
      );
    } catch (error) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Stop Failed",
          body: String(error),
        },
        activeThread.id,
      );
    } finally {
      setCancelingThreadID("");
    }
  }

  async function onRegenerateActiveSession() {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    const prompt = lastUserPromptFromTimeline(activeThread.timeline);
    if (!prompt) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Regenerate Unavailable",
          body: "No previous user prompt in this session.",
        },
        activeThread.id,
      );
      return;
    }
    await submitPromptForActiveThread(prompt);
  }

  async function onForkActiveSession() {
    if (!activeThread) return;
    if (authPhase !== "ready" || !token.trim()) {
      forkThread(activeThread.id);
      return;
    }
    const runtimeName = activeRuntime?.name ?? selectedRuntime;
    if (
      runtimeName !== "codex" ||
      isLocalDraftSessionID(activeThread.id)
    ) {
      forkThread(activeThread.id);
      return;
    }
    try {
      const response = await forkCodexV2Session(token, activeThread.id, {
        host_id: activeWorkspace?.hostID?.trim() || undefined,
        path: activeWorkspace?.path?.trim() || undefined,
        title: `Fork · ${activeThread.title}`,
      });
      const nextID =
        extractThreadIDFromCodexSessionResponse(response) ||
        response.session.id.trim();
      await refreshProjectsFromSource(token, hosts, true, true);
      if (nextID) {
        activateThread(nextID);
      }
    } catch (error) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Fork Failed",
          body: String(error),
        },
        activeThread.id,
      );
    }
  }

  async function onEditAndResend(entry: TimelineEntry) {
    if (authPhase !== "ready" || !token.trim() || !activeThread) return;
    if (entry.kind !== "user") return;
    const edited = window.prompt("Edit prompt before resend", entry.body);
    if (edited === null) return;
    const trimmed = edited.trim();
    if (!trimmed) {
      addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Prompt Missing",
          body: "Prompt is required.",
        },
        activeThread.id,
      );
      return;
    }
    await submitPromptForActiveThread(trimmed);
  }

  async function onRunPlatformLogin(action: "status" | "login_device" | "logout") {
    if (authPhase !== "ready" || !token.trim()) return;
    const hostID = platformHostID.trim();
    if (!hostID) {
      setPlatformNotice("Select a target host first.");
      return;
    }
    setPlatformBusySection("login");
    setPlatformNotice(`Running login ${action} on ${platformHost?.name ?? hostID}...`);
    try {
      const result = await codexPlatformLogin(token, {
        host_id: hostID,
        action,
      });
      setPlatformLoginResult(result);
      setPlatformNotice(`Login ${action} finished on ${result.host.name}.`);
    } catch (error) {
      setPlatformNotice(String(error));
    } finally {
      setPlatformBusySection("");
    }
  }

  async function onRunPlatformMCP() {
    if (authPhase !== "ready" || !token.trim()) return;
    const hostID = platformHostID.trim();
    if (!hostID) {
      setPlatformNotice("Select a target host first.");
      return;
    }
    const command = platformMCPCommand
      .trim()
      .split(/\s+/)
      .filter((item) => item !== "");
    const request: {
      host_id: string;
      action: CodexPlatformMCPAction;
      name?: string;
      url?: string;
      command?: string[];
      env?: string[];
      bearer_token_env_var?: string;
      scopes?: string[];
    } = {
      host_id: hostID,
      action: platformMCPAction,
    };
    if (platformMCPName.trim()) {
      request.name = platformMCPName.trim();
    }
    if (platformMCPURL.trim()) {
      request.url = platformMCPURL.trim();
    }
    if (command.length > 0) {
      request.command = command;
    }
    const envValues = splitCSVValues(platformMCPEnvCSV);
    if (envValues.length > 0) {
      request.env = envValues;
    }
    if (platformMCPBearerTokenEnvVar.trim()) {
      request.bearer_token_env_var = platformMCPBearerTokenEnvVar.trim();
    }
    const scopeValues = splitCSVValues(platformMCPScopeCSV);
    if (scopeValues.length > 0) {
      request.scopes = scopeValues;
    }

    setPlatformBusySection("mcp");
    setPlatformNotice(`Running mcp ${platformMCPAction} on ${platformHost?.name ?? hostID}...`);
    try {
      const result = await codexPlatformMCP(token, request);
      setPlatformMCPResult(result);
      setPlatformNotice(`MCP ${platformMCPAction} finished on ${result.host.name}.`);
    } catch (error) {
      setPlatformNotice(String(error));
    } finally {
      setPlatformBusySection("");
    }
  }

  async function onRunPlatformCloud() {
    if (authPhase !== "ready" || !token.trim()) return;
    const hostID = platformHostID.trim();
    if (!hostID) {
      setPlatformNotice("Select a target host first.");
      return;
    }
    const attempts = Number.parseInt(platformCloudAttempts, 10);
    const limit = Number.parseInt(platformCloudLimit, 10);
    const attempt = Number.parseInt(platformCloudAttempt, 10);
    const request: {
      host_id: string;
      action: CodexPlatformCloudAction;
      task_id?: string;
      env_id?: string;
      query?: string;
      attempts?: number;
      branch?: string;
      limit?: number;
      cursor?: string;
      attempt?: number;
    } = {
      host_id: hostID,
      action: platformCloudAction,
    };
    if (platformCloudTaskID.trim()) {
      request.task_id = platformCloudTaskID.trim();
    }
    if (platformCloudEnvID.trim()) {
      request.env_id = platformCloudEnvID.trim();
    }
    if (platformCloudQuery.trim()) {
      request.query = platformCloudQuery.trim();
    }
    if (Number.isFinite(attempts) && attempts > 0) {
      request.attempts = attempts;
    }
    if (platformCloudBranch.trim()) {
      request.branch = platformCloudBranch.trim();
    }
    if (Number.isFinite(limit) && limit > 0) {
      request.limit = limit;
    }
    if (platformCloudCursor.trim()) {
      request.cursor = platformCloudCursor.trim();
    }
    if (Number.isFinite(attempt) && attempt > 0) {
      request.attempt = attempt;
    }

    setPlatformBusySection("cloud");
    setPlatformNotice(`Running cloud ${platformCloudAction} on ${platformHost?.name ?? hostID}...`);
    try {
      const result = await codexPlatformCloud(token, request);
      setPlatformCloudResult(result);
      setPlatformNotice(
        `Cloud ${platformCloudAction} finished on ${result.host.name}.`,
      );
    } catch (error) {
      setPlatformNotice(String(error));
    } finally {
      setPlatformBusySection("");
    }
  }

  async function onAddHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPhase !== "ready" || !token.trim()) return;

    const mode = hostForm.connectionMode ?? "ssh";
    if (!hostForm.name.trim() || (mode === "ssh" && !hostForm.host.trim())) {
      const validationMessage =
        mode === "ssh"
          ? "name and host are required for ssh mode."
          : "name is required.";
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Validation",
        body: validationMessage,
      });
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
        workspace: hostForm.workspace.trim() || undefined,
      });
      setHostForm({
        name: "",
        connectionMode: "ssh",
        host: "",
        user: "",
        workspace: "",
      });
      setEditingHostID("");
      await loadWorkspace(token);
      addTimelineEntry({
        kind: "system",
        state: "success",
        title: editing ? "Host Updated" : "Host Saved",
        body: `${editing ? "Updated" : "Saved"} host ${hostName}.`,
      });
      setOpsNotice(`${editing ? "Updated" : "Saved"} host ${hostName}.`);
    } catch (error) {
      addTimelineEntry({
        kind: "system",
        state: "error",
        title: "Host Save Failed",
        body: String(error),
      });
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
      workspace: host.workspace ?? "",
    });
    setOpsNotice(`Editing host ${host.name}.`);
  }

  function onCancelHostEdit() {
    setEditingHostID("");
    setHostForm({
      name: "",
      connectionMode: "ssh",
      host: "",
      user: "",
      workspace: "",
    });
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
      const codexErr = result.codex?.error
        ? ` codex_error=${result.codex.error}`
        : "";
      const loginErr = result.codex_login?.error
        ? ` login_error=${result.codex_login.error}`
        : "";
      setOpsNotice(
        `Probe ${host.name}: ssh=${ssh} codex=${codex} login=${login}${sshErr}${codexErr}${loginErr}`,
      );
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
      await loadWorkspace(token);
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
      await loadWorkspace(token);
    } catch (error) {
      setOpsNotice(`Cancel failed for ${job.id}: ${String(error)}`);
    }
  }

  async function onUploadSessionImage(
    file: File,
    threadID = activeThread?.id ?? "",
  ) {
    if (authPhase !== "ready" || !token.trim()) return;
    const targetThreadID = threadID.trim();
    if (!targetThreadID) return;
    if (!file.type.toLowerCase().startsWith("image/")) {
      setImageUploadError("Only image files are supported.");
      return;
    }
    setUploadingImage(true);
    setImageUploadError("");
    try {
      const uploaded = await uploadImage(token, file);
      addThreadImagePath(targetThreadID, uploaded.path);
    } catch (error) {
      setImageUploadError(String(error));
    } finally {
      setUploadingImage(false);
    }
  }

  function onComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (!activeThread || activeThreadBusy) return;
    const imageFile = firstImageFile(event.clipboardData?.files);
    if (!imageFile) return;
    event.preventDefault();
    void onUploadSessionImage(imageFile, activeThread.id);
  }

  function onComposerDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!activeThread || activeThreadBusy) return;
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    composerDragDepthRef.current += 1;
    setComposerDropActive(true);
  }

  function onComposerDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!activeThread || activeThreadBusy) return;
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!composerDropActive) {
      setComposerDropActive(true);
    }
  }

  function onComposerDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!composerDropActive) return;
    event.preventDefault();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current > 0) return;
    setComposerDropActive(false);
  }

  function onComposerDrop(event: ReactDragEvent<HTMLElement>) {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    composerDragDepthRef.current = 0;
    setComposerDropActive(false);
    if (!activeThread || activeThreadBusy) return;
    const imageFile = firstImageFile(event.dataTransfer?.files);
    if (!imageFile) return;
    void onUploadSessionImage(imageFile, activeThread.id);
  }

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
