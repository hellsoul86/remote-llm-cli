import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "./api";
import { useOpsDomain } from "./domains/ops";
import { clearStoredToken, loadStoredToken } from "./domains/auth-token";
import { isSecondarySurfaceTimelineEntry } from "./domains/timeline-noise";
import { useSessionDomain } from "./domains/session";
import { AppChrome } from "./features/session/components/AppChrome";
import { CommandPalette } from "./features/session/components/CommandPalette";
import { OpsStage } from "./features/session/components/OpsStage";
import { SessionStage } from "./features/session/components/SessionStage";
import { TokenGate } from "./features/session/components/TokenGate";
import { buildOpsStageProps } from "./features/session/ops-stage-props";
import { buildSessionComposerProps } from "./features/session/session-composer-props";
import { buildSessionSidebarProps } from "./features/session/session-sidebar-props";
import { buildSessionStageProps } from "./features/session/session-stage-props";
import { useAppMode } from "./features/session/use-app-mode";
import { useComposerAutoResize } from "./features/session/use-composer-autosize";
import { useCompletedRuns } from "./features/session/use-completed-runs";
import { useCommandPaletteController } from "./features/session/use-command-palette";
import { useCodexPlatformController } from "./features/session/use-codex-platform-controller";
import { useGlobalShortcuts } from "./features/session/use-global-shortcuts";
import { useSessionAlerts } from "./features/session/use-session-alerts";
import { useSessionEventCursor } from "./features/session/use-session-event-cursor";
import { useOpsPolling } from "./features/session/use-ops-polling";
import { useSessionJobPolling } from "./features/session/use-session-job-polling";
import { useSessionRuntimeEffects } from "./features/session/use-session-runtime-effects";
import { useSessionStreamHealth } from "./features/session/use-session-stream-health";
import { useTimelineEntryBody } from "./features/session/use-timeline-entry-body";
import { useTimelineScrollController } from "./features/session/use-timeline-scroll";
import { useCodexPendingRequests } from "./features/session/use-codex-pending-requests";
import { useProjectReviewGit } from "./features/session/use-project-review-git";
import { useProjectTerminalSession } from "./features/session/use-project-terminal-session";
import { createProjectSourceActions } from "./features/session/project-source-actions";
import { createHostActions } from "./features/session/host-actions";
import { createOpsJobActions } from "./features/session/ops-job-actions";
import { createProjectActions } from "./features/session/project-actions";
import { createComposerImageActions } from "./features/session/composer-image-actions";
import { createSessionReviewAction } from "./features/session/session-review-action";
import { createSessionControlActions } from "./features/session/session-control-actions";
import { createSessionSecondaryActions } from "./features/session/session-secondary-actions";
import { createSessionSubmitAction } from "./features/session/session-submit-action";
import { createSessionUIActions } from "./features/session/session-ui-actions";
import { createWorkspaceAuthActions } from "./features/session/workspace-auth-actions";
import {
  buildSessionCommandPaletteActions,
  normalizeSearchText,
  type CommandPaletteAction,
} from "./features/session/command-palette";
import {
  APPROVAL_POLICY_OPTIONS,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  DEFAULT_WORKSPACE_PATH,
  MAX_COMPLETED_RUN_CACHE_SIZE,
  MAX_SESSION_STREAMS,
  TIMELINE_JUMP_COUNT_CAP,
  TIMELINE_STICK_GAP_PX,
} from "./features/session/config";
import {
  clearSessionRuntimePersistence,
  loadSessionTreePrefs,
  persistSessionTreePrefs,
} from "./features/session/persistence";
import { type SessionTreeHost } from "./features/session/types";
import {
  collectVisibleTreeSessionIDs,
  filterSessionTreeHosts,
  buildSessionTreeHosts,
} from "./features/session/tree";
import { buildSessionStreamTargetIDs } from "./features/session/stream-targets";
import { createSessionRunEventHandlers } from "./features/session/session-run-events";
import {
  parseCodexFileChangesBody,
  parseCodexCommandEventBody,
  parseCodexPatchDeltaBody,
  parseCodexTurnDiffBody,
} from "./features/session/codex-parsing";
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
  isJobActive,
  lastUserPromptFromTimeline,
} from "./features/session/runtime-utils";
import { pendingRequestsStatusCopy } from "./features/session/pending-request-utils";
import {
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
  const [tokenInput, setTokenInput] = useState<string>(() => loadStoredToken());
  const [authError, setAuthError] = useState("");
  const { appMode, switchMode } = useAppMode();

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
    setThreadCodexMode,
    setThreadReviewUncommitted,
    setThreadReviewBase,
    setThreadReviewCommit,
    setThreadReviewTitle,
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
  const [reviewPaneOpen, setReviewPaneOpen] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  const [terminalClearCutoffByThread, setTerminalClearCutoffByThread] =
    useState<Record<string, string>>({});
  const [addDirDraft, setAddDirDraft] = useState("");
  const [configFlagDraft, setConfigFlagDraft] = useState("");
  const [enableFlagDraft, setEnableFlagDraft] = useState("");
  const [disableFlagDraft, setDisableFlagDraft] = useState("");
  const [composerDropActive, setComposerDropActive] = useState(false);
  const sessionTreePrefs = useMemo(() => loadSessionTreePrefs(), []);
  const [projectFilter, setProjectFilter] = useState(
    sessionTreePrefs.projectFilter,
  );
  const [collapsedHostIDs, setCollapsedHostIDs] = useState<string[]>(
    sessionTreePrefs.collapsedHostIDs,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    sessionTreePrefs.sidebarCollapsed,
  );
  const [treeCursorSessionID, setTreeCursorSessionID] = useState("");
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const composerDragDepthRef = useRef(0);
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
  const activeWorkspaceHostID = activeWorkspace?.hostID?.trim() ?? "";
  const activeWorkspacePath = activeWorkspace?.path?.trim() ?? "";
  const projectTerminal = useProjectTerminalSession({
    enabled:
      authPhase === "ready" &&
      terminalDrawerOpen &&
      activeWorkspaceID.trim() !== "",
    token,
    projectID: activeWorkspaceID,
  });
  const projectReviewGit = useProjectReviewGit({
    enabled:
      authPhase === "ready" &&
      reviewPaneOpen &&
      activeWorkspaceID.trim() !== "",
    token,
    projectID: activeWorkspaceID,
  });
  const sessionTreeHosts = useMemo<SessionTreeHost[]>(
    () => buildSessionTreeHosts(hosts, workspaces, activeWorkspaceID),
    [hosts, workspaces, activeWorkspaceID],
  );
  const sourceProjectIDSet = useMemo(
    () =>
      new Set(
        sourceProjectIDs.map((id) => id.trim()).filter((id) => id !== ""),
      ),
    [sourceProjectIDs],
  );
  const filteredSessionTreeHosts = useMemo<SessionTreeHost[]>(
    () => filterSessionTreeHosts(sessionTreeHosts, projectFilter),
    [projectFilter, sessionTreeHosts],
  );
  const visibleTreeSessionIDs = useMemo(
    () =>
      collectVisibleTreeSessionIDs(filteredSessionTreeHosts, collapsedHostIDs),
    [collapsedHostIDs, filteredSessionTreeHosts],
  );
  const activeThreadBusy =
    Boolean(activeThread?.activeJobID) ||
    (activeThread ? submittingThreadID === activeThread.id : false) ||
    (activeThread ? deletingThreadID === activeThread.id : false) ||
    (activeThread ? cancelingThreadID === activeThread.id : false);
  const {
    activeRequests: activePendingRequests,
    loading: pendingRequestsLoading,
    error: pendingRequestsError,
    resolvingRequestID: resolvingPendingRequestID,
    refreshPendingRequests,
    resolvePendingRequest,
  } = useCodexPendingRequests({
    authReady: authPhase === "ready",
    token,
    sessionID: activeThreadID,
    watchFast: activeThreadBusy,
  });
  const activeThreadRunID = activeThread?.activeJobID.trim() ?? "";
  const hasRegeneratePrompt =
    activeThread !== null &&
    lastUserPromptFromTimeline(activeThread.timeline).trim() !== "";
  const pendingRequestCopy = pendingRequestsStatusCopy(activePendingRequests);
  const activeThreadStatusCopy = pendingRequestCopy
    ? pendingRequestCopy
    : activeThreadBusy
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
  const activeStreamCopy = streamHealthCopy(
    activeStreamState,
    activeStreamRetries,
  );
  const activeStreamTone = streamHealthTone(activeStreamState);
  const activeStreamLastError =
    activeSessionStreamHealth?.lastError.trim() ?? "";
  const canReconnectActiveStream =
    authPhase === "ready" &&
    token.trim() !== "" &&
    activeThreadID.trim() !== "" &&
    activeStreamState !== "live";
  const reviewMode = activeThread?.codexMode ?? "exec";
  const activeTerminalClearCutoff = activeThreadID
    ? (terminalClearCutoffByThread[activeThreadID] ?? "")
    : "";
  const activeThreadModelValue = useMemo(() => {
    const current = activeThread?.model.trim() ?? "";
    if (current) return current;
    if (sessionModelDefault.trim()) return sessionModelDefault.trim();
    return sessionModelOptions[0]?.trim() ?? "";
  }, [activeThread?.model, sessionModelDefault, sessionModelOptions]);
  const visibleTimeline = useMemo(
    () =>
      activeTimeline.filter((entry) => !isSecondarySurfaceTimelineEntry(entry)),
    [activeTimeline],
  );
  const reviewFindings = useMemo(
    () =>
      activeTimeline
        .filter(
          (entry) =>
            (entry.kind === "assistant" || entry.kind === "system") &&
            entry.body.trim() !== "" &&
            !isSecondarySurfaceTimelineEntry(entry),
        )
        .slice(-6)
        .reverse()
        .map((entry) => ({
          id: entry.id,
          title:
            entry.title.trim() ||
            (entry.kind === "assistant" ? "Assistant" : "System"),
          body: entry.body.trim(),
          timestamp: formatClock(entry.createdAt),
          tone:
            entry.kind === "system"
              ? ("system" as const)
              : ("assistant" as const),
        })),
    [activeTimeline],
  );
  const reviewTurnDiff = useMemo(() => {
    for (let index = activeTimeline.length - 1; index >= 0; index -= 1) {
      const entry = activeTimeline[index];
      if (!entry || entry.kind !== "system") continue;
      if (entry.title.trim().toLowerCase() !== "review diff updated") continue;
      const diff = parseCodexTurnDiffBody(entry.body);
      if (diff.trim()) return diff;
    }
    return "";
  }, [activeTimeline]);
  const reviewPatchDelta = useMemo(() => {
    return activeTimeline
      .filter(
        (entry) =>
          entry.kind === "system" &&
          entry.title.trim().toLowerCase() === "patch diff delta",
      )
      .map((entry) => parseCodexPatchDeltaBody(entry.body))
      .filter((value) => value.trim() !== "")
      .slice(-12)
      .join("\n");
  }, [activeTimeline]);
  const reviewChanges = useMemo(() => {
    const out: Array<{
      id: string;
      path: string;
      kind: string;
      state: "running" | "success" | "error";
      title: string;
      summary: string;
      diff: string;
      timestamp: string;
    }> = [];
    for (const entry of activeTimeline) {
      if (entry.kind !== "system") continue;
      const title = entry.title.trim();
      if (!/^Patch (Started|Applied|Failed)$/i.test(title)) continue;
      const changes = parseCodexFileChangesBody(entry.body);
      if (changes.length === 0) continue;
      changes.forEach((change, index) => {
        out.push({
          id: `${entry.id}:${index}`,
          path: change.path,
          kind: change.kind,
          state: entry.state ?? "success",
          title,
          summary: `${change.kind} ${change.path}`,
          diff: change.diff,
          timestamp: formatClock(entry.createdAt),
        });
      });
    }
    return out.reverse();
  }, [activeTimeline]);
  const visibleReviewChanges = useMemo(() => {
    if (!projectReviewGit.known) {
      return reviewChanges;
    }
    const changedPathSet = new Set(
      projectReviewGit.changedPaths.map((path) => path.trim()).filter(Boolean),
    );
    return reviewChanges.filter((change) =>
      changedPathSet.has(change.path.trim()),
    );
  }, [projectReviewGit.changedPaths, projectReviewGit.known, reviewChanges]);
  const terminalCommands = useMemo(() => {
    const cutoffMS = activeTerminalClearCutoff
      ? Date.parse(activeTerminalClearCutoff)
      : Number.NaN;
    const entries = activeTimeline.filter((entry) => {
      if (entry.kind !== "system") return false;
      if (
        !/^Command (Started|Completed|Failed)$/i.test(entry.title.trim()) &&
        entry.title.trim().toLowerCase() !== "command output delta" &&
        entry.title.trim().toLowerCase() !== "terminal interaction"
      ) {
        return false;
      }
      if (entry.body.trim() === "") return false;
      if (!Number.isFinite(cutoffMS)) return true;
      const createdAtMS = Date.parse(entry.createdAt);
      return !Number.isFinite(createdAtMS) || createdAtMS > cutoffMS;
    });

    const byCommand = new Map<
      string,
      {
        id: string;
        title: string;
        command: string;
        output: string;
        interactions: string[];
        processId: string;
        timestamp: string;
        state: "running" | "success" | "error";
      }
    >();

    for (const entry of entries) {
      const title = entry.title.trim() || "Command";
      const metadata = parseCodexCommandEventBody(entry.body);
      if (metadata) {
        const key = metadata.itemId.trim() || entry.id;
        const existing = byCommand.get(key) ?? {
          id: key,
          title,
          command: metadata.command.trim() || "command",
          output: "",
          interactions: [],
          processId: metadata.processId.trim(),
          timestamp: formatClock(entry.createdAt),
          state:
            entry.state ??
            (title.toLowerCase().includes("failed")
              ? ("error" as const)
              : title.toLowerCase().includes("completed")
                ? ("success" as const)
                : ("running" as const)),
        };
        if (metadata.command.trim()) {
          existing.command = metadata.command.trim();
        }
        if (metadata.processId.trim()) {
          existing.processId = metadata.processId.trim();
        }
        existing.timestamp = formatClock(entry.createdAt);
        if (metadata.phase === "delta") {
          existing.output = `${existing.output}${metadata.output}`;
        } else if (metadata.phase === "interaction") {
          existing.interactions.push(metadata.stdin);
        } else {
          existing.title = title;
          existing.state =
            entry.state ??
            (title.toLowerCase().includes("failed")
              ? ("error" as const)
              : title.toLowerCase().includes("completed")
                ? ("success" as const)
                : ("running" as const));
          if (metadata.output.trim()) {
            existing.output = metadata.output;
          }
        }
        byCommand.set(key, existing);
        continue;
      }

      const [commandLine, ...outputLines] = entry.body.split("\n");
      byCommand.set(entry.id, {
        id: entry.id,
        title,
        command: commandLine?.trim() || "command",
        output: outputLines.join("\n").trim(),
        interactions: [],
        processId: "",
        timestamp: formatClock(entry.createdAt),
        state:
          entry.state ??
          (title.toLowerCase().includes("failed")
            ? ("error" as const)
            : title.toLowerCase().includes("started")
              ? ("running" as const)
              : ("success" as const)),
      });
    }

    return Array.from(byCommand.values()).slice(-8);
  }, [activeTerminalClearCutoff, activeTimeline]);
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
  const {
    createThreadAndFocus,
    focusComposerSoon,
    onAddDirDraftSubmit,
    onConfigFlagDraftSubmit,
    onEnableFlagDraftSubmit,
    onDisableFlagDraftSubmit,
    openProjectComposer,
    closeProjectComposer,
    registerSessionButtonRef,
    onSessionTreeKeyDown,
    toggleHostCollapsed,
    openSessionFromAlert,
  } = createSessionUIActions({
    createThread,
    promptInputRef,
    activeThread,
    addDirDraft,
    setAddDirDraft,
    addThreadAddDir,
    configFlagDraft,
    setConfigFlagDraft,
    addThreadConfigFlag,
    enableFlagDraft,
    setEnableFlagDraft,
    addThreadEnableFlag,
    disableFlagDraft,
    setDisableFlagDraft,
    addThreadDisableFlag,
    activeWorkspaceHostID,
    activeWorkspacePath,
    hosts,
    setProjectComposerOpen,
    setProjectFormHostID,
    setProjectFormPath,
    setProjectFormTitle,
    sessionButtonRefs,
    visibleTreeSessionIDs,
    treeCursorSessionID,
    setTreeCursorSessionID,
    activateThread,
    setThreadPinned,
    setCollapsedHostIDs,
    threadWorkspaceMap,
    switchMode,
    dismissSessionAlert,
  });
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
  const activeTimelineTail = visibleTimeline[visibleTimeline.length - 1];
  const {
    timelineUnreadCount,
    timelineViewportRef,
    timelineBottomRef,
    onTimelineScroll,
    jumpTimelineToLatest,
    forceStickToBottom,
  } = useTimelineScrollController({
    activeThreadID,
    timelineLength: visibleTimeline.length,
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
  useEffect(() => {
    if (!activeThread) {
      setReviewPaneOpen(false);
      return;
    }
    if (activeThread.codexMode === "review") {
      setReviewPaneOpen(true);
    }
  }, [activeThreadID, activeThread?.codexMode]);

  useEffect(() => {
    if (!activeThreadID.trim()) {
      setTerminalDrawerOpen(false);
    }
  }, [activeThreadID]);

  function onToggleReviewPane() {
    if (!activeThread) return;
    setReviewPaneOpen((prev) => !prev);
  }

  function onToggleTerminalDrawer() {
    if (!activeThread) return;
    setTerminalDrawerOpen((prev) => !prev);
  }

  function onClearTerminalDrawer() {
    if (!activeThreadID.trim()) return;
    projectTerminal.clear();
    setTerminalClearCutoffByThread((prev) => ({
      ...prev,
      [activeThreadID]: new Date().toISOString(),
    }));
  }

  function onSetActiveThreadReviewMode(mode: "exec" | "resume" | "review") {
    if (!activeThread) return;
    setThreadCodexMode(activeThread.id, mode);
    if (mode === "review") {
      setReviewPaneOpen(true);
    }
  }

  function onSetActiveThreadReviewUncommitted(next: boolean) {
    if (!activeThread) return;
    setThreadReviewUncommitted(activeThread.id, next);
  }

  function onSetActiveThreadReviewBase(value: string) {
    if (!activeThread) return;
    setThreadReviewBase(activeThread.id, value);
  }

  function onSetActiveThreadReviewCommit(value: string) {
    if (!activeThread) return;
    setThreadReviewCommit(activeThread.id, value);
  }

  function onSetActiveThreadReviewTitle(value: string) {
    if (!activeThread) return;
    setThreadReviewTitle(activeThread.id, value);
  }

  useGlobalShortcuts({
    authReady: authPhase === "ready",
    appMode,
    commandPaletteOpen,
    onOpenCommandPalette: () => openCommandPalette(),
    onCloseCommandPalette: () => closeCommandPalette(),
    onToggleSidebar: () => setSidebarCollapsed((prev) => !prev),
    onCreateThreadAndFocus: createThreadAndFocus,
    onSwitchThreadByOffset: switchThreadByOffset,
    terminalDrawerOpen,
    terminalHasLiveTransport: projectTerminal.hasLiveTransport,
    onToggleTerminalDrawer,
    onClearTerminalDrawer,
    onToggleReviewPane,
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
    () => new Set(jobs.map((job) => job.id.trim()).filter((id) => id !== "")),
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
    if (authPhase !== "ready") {
      document.title = "Sign In · Codex";
      return;
    }
    const title =
      activeThread?.title.trim() ||
      activeWorkspace?.title.trim() ||
      "Codex";
    document.title = `${title} · Codex`;
  }, [authPhase, activeThread?.title, activeWorkspace?.title]);

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
      for (const [
        sessionID,
        state,
      ] of sessionStreamStateRef.current.entries()) {
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
      sidebarCollapsed,
    });
  }, [projectFilter, collapsedHostIDs, sidebarCollapsed]);

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
    const fallbackHostID =
      activeWorkspace?.hostID?.trim() || hosts[0]?.id || "";
    if (
      !projectFormHostID ||
      !hosts.some((host) => host.id === projectFormHostID)
    ) {
      setProjectFormHostID(fallbackHostID);
    }
    if (!projectFormPath.trim()) {
      setProjectFormPath(
        activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
      );
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
      prev && visibleTreeSessionIDs.includes(prev)
        ? prev
        : visibleTreeSessionIDs[0],
    );
  }, [visibleTreeSessionIDs]);

  function shouldSurfaceCompletion(createdAt?: string): boolean {
    const ts = createdAt?.trim();
    if (!ts) return false;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) return false;
    return parsed >= completionAlertCutoffMSRef.current;
  }

  const { ensureLocalCodexHost, refreshProjectsFromSource } =
    createProjectSourceActions({
      activeWorkspacePath:
        activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
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
    workspaces,
    sessionStreamTargetIDs,
    sessionStreamStateRef,
    sessionStreamHealthByID,
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

  const {
    onRefreshWorkspace,
    onArchiveActiveSession,
    onReconnectActiveStream,
  } = createSessionControlActions({
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
  const { startReviewForActiveThread } = createSessionReviewAction({
    authPhase,
    token,
    activeThread,
    submittingThreadID,
    activeWorkspaceHostID: activeWorkspace?.hostID?.trim() ?? "",
    activeWorkspacePath: activeWorkspace?.path?.trim() ?? "",
    hosts,
    selectedHostIDs,
    activeThreadIDRef,
    sessionRunStateRef,
    sessionStreamStateRef,
    addTimelineEntry,
    bindThreadID,
    stopSessionStream,
    deleteSessionEventCursor,
    setThreadJobState,
    setActiveJobThreadID,
    setActiveJobID,
    startSessionStream,
    setSubmittingThreadID,
    setThreadCodexMode,
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
    activeWorkspaceHostID,
    activeWorkspacePath,
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
  const { renderTimelineEntryBody } = useTimelineEntryBody({
    authPhase,
    token,
    activeThreadBusy,
    onEditAndResend,
  });
  const { panelProps: platformPanelProps } = useCodexPlatformController({
    authPhase,
    token,
    hosts,
    activeWorkspaceHostID,
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

  const sessionSidebarProps = buildSessionSidebarProps({
    authReady: authPhase === "ready",
    hasToken: token.trim() !== "",
    hosts,
    projectComposerOpen,
    onOpenProjectComposer: openProjectComposer,
    onCreateThread: createThreadAndFocus,
    onCreateProject,
    projectFormHostID,
    setProjectFormHostID,
    projectFormPath,
    setProjectFormPath,
    projectFormTitle,
    setProjectFormTitle,
    upsertingProjectID,
    onCloseProjectComposer: closeProjectComposer,
    projectFilter,
    setProjectFilter,
    sessionTreeHosts,
    filteredSessionTreeHosts,
    collapsedHostIDs,
    onToggleHostCollapsed: toggleHostCollapsed,
    activeWorkspaceID,
    onSelectWorkspace: setActiveWorkspaceID,
    onFocusComposer: focusComposerSoon,
    onRenameProjectAsync: onRenameProject,
    onArchiveProjectAsync: onArchiveProject,
    deletingProjectID,
    registerSessionButtonRef,
    activeThreadID,
    treeCursorSessionID,
    setTreeCursorSessionID,
    onActivateThread: activateThread,
    onSetThreadPinned: setThreadPinned,
    onSessionTreeKeyDown,
    notificationPermission,
    onEnableNotificationsAsync: onEnableNotifications,
    setSessionAlertsExpanded,
    sessionAlertsExpanded,
    sessionAlerts,
    onClearSessionAlerts: clearSessionAlerts,
    onOpenSessionFromAlert: openSessionFromAlert,
  });

  const sessionComposerProps = buildSessionComposerProps({
    formRef: composerFormRef,
    promptInputRef,
    composerDropActive,
    onSubmit: onSendPrompt,
    onDragEnter: onComposerDragEnter,
    onDragOver: onComposerDragOver,
    onDragLeave: onComposerDragLeave,
    onDrop: onComposerDrop,
    activeThreadStatusCopy,
    activeThread,
    activeThreadBusy,
    activeThreadModelValue,
    hasSessionModelChoices,
    sessionModelChoices,
    sessionModelDefault,
    setThreadModel,
    setThreadSandbox,
    onForkActiveSession,
    sessionAdvancedOpen,
    setSessionAdvancedOpen,
    approvalPolicyOptions: APPROVAL_POLICY_OPTIONS,
    setThreadApprovalPolicy,
    setThreadWebSearch,
    setThreadProfile,
    configFlagDraft,
    onConfigFlagDraftChange: setConfigFlagDraft,
    onConfigFlagDraftSubmit,
    removeThreadConfigFlag,
    enableFlagDraft,
    onEnableFlagDraftChange: setEnableFlagDraft,
    onEnableFlagDraftSubmit,
    removeThreadEnableFlag,
    disableFlagDraft,
    onDisableFlagDraftChange: setDisableFlagDraft,
    onDisableFlagDraftSubmit,
    removeThreadDisableFlag,
    addDirDraft,
    onAddDirDraftChange: setAddDirDraft,
    onAddDirDraftSubmit,
    removeThreadAddDir,
    setThreadSkipGitRepoCheck,
    setThreadJSONOutput,
    setThreadEphemeral,
    pendingRequests: activePendingRequests,
    pendingRequestsLoading,
    pendingRequestsError,
    resolvingPendingRequestID,
    refreshPendingRequests,
    resolvePendingRequest,
    uploadingImage,
    imageUploadError,
    onUploadSessionImage,
    removeThreadImagePath,
    activeDraft,
    updateThreadDraft,
    onComposerPaste,
    activeThreadRunID,
    cancelingThreadID,
    onStopActiveSessionRun,
    hasRegeneratePrompt,
    onRegenerateActiveSession,
  });

  const opsStageProps = buildOpsStageProps({
    health,
    allHosts,
    onAllHostsChange: setAllHosts,
    selectedHostCount,
    hostFilter,
    onHostFilterChange: setHostFilter,
    hosts,
    filteredHosts,
    selectedHostIDs,
    onToggleHostSelection: toggleHostSelection,
    opsHostBusyID,
    onProbeHost,
    onStartEditHost,
    onDeleteHost,
    selectedRuntime,
    onSelectedRuntimeChange: setSelectedRuntime,
    runtimes,
    runSandbox,
    onRunSandboxChange: setRunSandbox,
    runAsyncMode,
    onRunAsyncModeChange: setRunAsyncMode,
    metrics,
    onRefreshWorkspace,
    isRefreshing,
    activeJob,
    onCancelJob,
    jobsLength: jobs.length,
    runsLength: runs.length,
    threadsLength: threads.length,
    opsNotice,
    opsNoticeIsError,
    platformPanelProps,
    activeJobThreadID,
    activeProgress,
    opsJobStatusFilter,
    onOpsJobStatusFilterChange: setOpsJobStatusFilter,
    opsJobTypeFilter,
    onOpsJobTypeFilterChange: setOpsJobTypeFilter,
    filteredOpsJobs,
    onSelectActiveJob: (job) => {
      setActiveJobID(job.id);
      setActiveJob(job);
    },
    opsRunStatusFilter,
    onOpsRunStatusFilterChange: setOpsRunStatusFilter,
    filteredOpsRuns,
    opsAuditMethodFilter,
    onOpsAuditMethodFilterChange: setOpsAuditMethodFilter,
    opsAuditStatusFilter,
    onOpsAuditStatusFilterChange: setOpsAuditStatusFilter,
    filteredAuditEvents,
    editingHostID,
    hostForm,
    onHostFormChange: setHostForm,
    addingHost,
    onSubmit: onAddHost,
    onCancelEdit: onCancelHostEdit,
  });
  const headerHostLabel =
    activeWorkspace?.hostName?.trim() &&
    activeWorkspace.hostName.trim() !== "local-default"
      ? activeWorkspace.hostName.trim()
      : "";
  const headerModeLabel =
    activeThread?.codexMode === "review"
      ? "Review"
      : activeThread?.codexMode === "resume"
        ? "Resume"
        : "";
  const sessionStageProps = buildSessionStageProps({
    sidebarProps: sessionSidebarProps,
    sidebarCollapsed,
    composerProps: sessionComposerProps,
    headerProjectTitle: activeWorkspace?.title?.trim() || "Untitled Project",
    headerProjectPath: activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
    headerHostLabel,
    headerTitle: activeThread?.title ?? "Session",
    headerModeLabel,
    headerModelLabel: activeThreadModelValue,
    streamTone: activeStreamTone,
    streamCopy: activeStreamCopy,
    streamLastError: activeStreamLastError,
    terminalDrawerOpen,
    canToggleTerminal: activeThread !== null,
    onToggleTerminalDrawer,
    terminalWorkdir: activeWorkspace?.path?.trim() || DEFAULT_WORKSPACE_PATH,
    terminalHostLabel: activeWorkspace?.hostName?.trim() || "",
    terminalCommands,
    terminalLiveStatus: projectTerminal.status,
    terminalLiveTransportAvailable: projectTerminal.hasLiveTransport,
    terminalLiveOutput: projectTerminal.output,
    terminalLiveError: projectTerminal.error,
    onTerminalSendInput: projectTerminal.sendInput,
    onTerminalResize: projectTerminal.resize,
    onTerminalInterrupt: projectTerminal.interrupt,
    onTerminalReconnect: projectTerminal.reconnect,
    onClearTerminalDrawer,
    reviewPaneOpen,
    canToggleReview: activeThread !== null,
    onToggleReviewPane,
    reviewMode,
    reviewBusy: activeThreadBusy,
    reviewUncommitted: activeThread?.reviewUncommitted ?? false,
    reviewBase: activeThread?.reviewBase ?? "",
    reviewCommit: activeThread?.reviewCommit ?? "",
    reviewTitle: activeThread?.reviewTitle ?? "",
    reviewTurnDiff,
    reviewPatchDelta,
    reviewChanges: visibleReviewChanges,
    reviewFindings,
    reviewGitStatusKnown: projectReviewGit.known,
    reviewGitStatusLoading: projectReviewGit.loading,
    reviewGitStatusMessage: projectReviewGit.message,
    reviewGitStatusTone: projectReviewGit.tone,
    reviewChangedPaths: projectReviewGit.changedPaths,
    reviewStagedPaths: projectReviewGit.stagedPaths,
    reviewGitBusyAction: projectReviewGit.busyAction,
    onRefreshReviewGitStatus: projectReviewGit.refresh,
    onStageReviewChange: projectReviewGit.stagePath,
    onRevertReviewChange: projectReviewGit.revertPath,
    onCommitReviewChanges: projectReviewGit.commitChanges,
    canStartReview:
      Boolean(activeThread) &&
      !activeThreadBusy &&
      authPhase === "ready" &&
      token.trim() !== "",
    onStartReview: startReviewForActiveThread,
    onSetReviewMode: onSetActiveThreadReviewMode,
    onSetReviewUncommitted: onSetActiveThreadReviewUncommitted,
    onSetReviewBase: onSetActiveThreadReviewBase,
    onSetReviewCommit: onSetActiveThreadReviewCommit,
    onSetReviewTitle: onSetActiveThreadReviewTitle,
    canArchive: Boolean(activeThread) && !activeThreadBusy,
    archiving: Boolean(activeThread && deletingThreadID === activeThread.id),
    onArchive: onArchiveActiveSession,
    canReconnect: canReconnectActiveStream,
    onReconnect: onReconnectActiveStream,
    timeline: visibleTimeline,
    isRefreshing,
    renderTimelineEntryBody,
    formatClock,
    timelineViewportRef,
    timelineBottomRef,
    onTimelineScroll,
    timelineUnreadCount,
    onJumpTimelineToLatest: jumpTimelineToLatest,
  });

  return (
    <div className="workspace-shell">
      <AppChrome
        appMode={appMode}
        sidebarCollapsed={sidebarCollapsed}
        isRefreshing={isRefreshing}
        healthIsError={healthIsError}
        health={health}
        onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
        onRefreshWorkspace={onRefreshWorkspace}
        onOpenUtilities={() => switchMode("ops")}
        onReturnToSession={() => switchMode("session")}
        onLogout={onLogout}
      />

      {appMode === "session" ? (
        <SessionStage {...sessionStageProps} />
      ) : (
        <OpsStage {...opsStageProps} />
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
