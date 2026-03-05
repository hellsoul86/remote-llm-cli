import { useEffect, useMemo, useRef, useState } from "react";

export type TimelineKind = "user" | "assistant" | "system";
export type TimelineState = "running" | "success" | "error";

export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  title: string;
  body: string;
  state?: TimelineState;
  createdAt: string;
};

export type CodexApprovalPolicy =
  | ""
  | "untrusted"
  | "on-failure"
  | "on-request"
  | "never";

export type CodexSessionMode = "exec" | "resume" | "review";

export type ConversationThread = {
  id: string;
  title: string;
  draft: string;
  timeline: TimelineEntry[];
  createdAt: string;
  updatedAt: string;
  model: string;
  codexMode: CodexSessionMode;
  resumeLast: boolean;
  resumeSessionID: string;
  reviewUncommitted: boolean;
  reviewBase: string;
  reviewCommit: string;
  reviewTitle: string;
  sandbox: "" | "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: CodexApprovalPolicy;
  webSearch: boolean;
  profile: string;
  configFlags: string[];
  enableFlags: string[];
  disableFlags: string[];
  addDirs: string[];
  skipGitRepoCheck: boolean;
  ephemeral: boolean;
  jsonOutput: boolean;
  imagePaths: string[];
  activeJobID: string;
  lastJobStatus: "idle" | "running" | "succeeded" | "failed" | "canceled";
  unreadDone: boolean;
  pinned: boolean;
};

export type WorkspaceDirectory = {
  id: string;
  hostID: string;
  hostName: string;
  path: string;
  title: string;
  sessions: ConversationThread[];
  activeSessionID: string;
  createdAt: string;
  updatedAt: string;
};

export type DiscoveredProjectSession = {
  id: string;
  title: string;
  updatedAt?: string;
};

export type DiscoveredProject = {
  id?: string;
  hostID: string;
  hostName: string;
  path: string;
  title?: string;
  sessions: DiscoveredProjectSession[];
};

type SyncProjectsOptions = {
  preserveMissingSessions?: boolean;
};

type PersistedSessionState = {
  workspaces: WorkspaceDirectory[];
  activeWorkspaceID: string;
};

const SESSION_STATE_KEY = "remote_llm_session_state_v1";
const DEFAULT_PROJECT_PATH = "/";

function projectTitleFromPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "Untitled Project";
  const parts = trimmed.split("/").filter((part) => part.trim() !== "");
  const tail = parts[parts.length - 1];
  return tail?.trim() || trimmed;
}

function normalizeApprovalPolicy(raw: unknown): CodexApprovalPolicy {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (
    value === "untrusted" ||
    value === "on-failure" ||
    value === "on-request" ||
    value === "never"
  ) {
    return value;
  }
  return "";
}

function normalizeSessionMode(raw: unknown): CodexSessionMode {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "resume" || value === "review") {
    return value;
  }
  return "exec";
}

function forkTitleFromSource(sourceTitle: string, fallbackIndex: number): string {
  const trimmed = sourceTitle.trim();
  if (!trimmed) return `Fork ${fallbackIndex}`;
  return `Fork · ${trimmed}`;
}

function createSession(index: number, title?: string): ConversationThread {
  const now = new Date().toISOString();
  return {
    id: `session_${Date.now()}_${index}`,
    title: title ?? `Session ${index}`,
    draft: "summarize current repo state and risks",
    timeline: [],
    createdAt: now,
    updatedAt: now,
    model: "",
    codexMode: "exec",
    resumeLast: true,
    resumeSessionID: "",
    reviewUncommitted: false,
    reviewBase: "",
    reviewCommit: "",
    reviewTitle: "",
    sandbox: "workspace-write",
    approvalPolicy: "",
    webSearch: false,
    profile: "",
    configFlags: [],
    enableFlags: [],
    disableFlags: [],
    addDirs: [],
    skipGitRepoCheck: true,
    ephemeral: false,
    jsonOutput: true,
    imagePaths: [],
    activeJobID: "",
    lastJobStatus: "idle",
    unreadDone: false,
    pinned: false
  };
}

function createForkSession(
  source: ConversationThread,
  index: number,
): ConversationThread {
  const now = new Date().toISOString();
  return {
    ...source,
    id: `session_${Date.now()}_${index}`,
    title: forkTitleFromSource(source.title, index),
    timeline: source.timeline.map((entry) => ({ ...entry })),
    addDirs: [...source.addDirs],
    imagePaths: [...source.imagePaths],
    createdAt: now,
    updatedAt: now,
    activeJobID: "",
    lastJobStatus: "idle",
    unreadDone: false,
    pinned: false
  };
}

function createWorkspace(index: number, path: string, hostID = "local", hostName = "local-default"): WorkspaceDirectory {
  const now = new Date().toISOString();
  const first = createSession(index, "Session 1");
  const title = projectTitleFromPath(path);
  return {
    id: `workspace_${Date.now()}_${index}`,
    hostID,
    hostName,
    path,
    title,
    sessions: [first],
    activeSessionID: first.id,
    createdAt: now,
    updatedAt: now
  };
}

function defaultState(): PersistedSessionState {
  const first = createWorkspace(1, DEFAULT_PROJECT_PATH);
  return {
    workspaces: [first],
    activeWorkspaceID: first.id
  };
}

function projectWorkspaceID(hostID: string, path: string): string {
  return `project_${hostID.trim()}::${path.trim()}`;
}

function normalizeSession(raw: unknown, index: number): ConversationThread {
  const fallback = createSession(index);
  if (!raw || typeof raw !== "object") return fallback;
  const candidate = raw as Partial<ConversationThread>;
  const now = new Date().toISOString();
  const timeline = Array.isArray(candidate.timeline)
    ? candidate.timeline
        .filter((entry): entry is TimelineEntry => {
          if (!entry || typeof entry !== "object") return false;
          const record = entry as Partial<TimelineEntry>;
          return typeof record.id === "string" && typeof record.kind === "string" && typeof record.title === "string" && typeof record.body === "string";
        })
        .map((entry) => ({
          ...entry,
          createdAt: typeof entry.createdAt === "string" ? entry.createdAt : now
        }))
    : [];
  const sandbox = candidate.sandbox;
  const safeSandbox =
    sandbox === "read-only" || sandbox === "workspace-write" || sandbox === "danger-full-access" || sandbox === "" ? sandbox : "workspace-write";
  const last = candidate.lastJobStatus;
  const safeLast =
    last === "idle" || last === "running" || last === "succeeded" || last === "failed" || last === "canceled"
      ? last
      : fallback.lastJobStatus;
  const addDirs = Array.isArray(candidate.addDirs)
    ? candidate.addDirs.filter(
        (path): path is string =>
          typeof path === "string" && path.trim() !== "",
      )
    : [];
  const configFlags = Array.isArray(candidate.configFlags)
    ? candidate.configFlags.filter(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      )
    : [];
  const enableFlags = Array.isArray(candidate.enableFlags)
    ? candidate.enableFlags.filter(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      )
    : [];
  const disableFlags = Array.isArray(candidate.disableFlags)
    ? candidate.disableFlags.filter(
        (value): value is string =>
          typeof value === "string" && value.trim() !== "",
      )
    : [];

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : fallback.id,
    title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : fallback.title,
    draft: typeof candidate.draft === "string" ? candidate.draft : "",
    timeline,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now,
    model: typeof candidate.model === "string" ? candidate.model : "",
    codexMode: normalizeSessionMode(candidate.codexMode),
    resumeLast:
      typeof candidate.resumeLast === "boolean" ? candidate.resumeLast : true,
    resumeSessionID:
      typeof candidate.resumeSessionID === "string"
        ? candidate.resumeSessionID
        : "",
    reviewUncommitted: Boolean(candidate.reviewUncommitted),
    reviewBase: typeof candidate.reviewBase === "string" ? candidate.reviewBase : "",
    reviewCommit:
      typeof candidate.reviewCommit === "string" ? candidate.reviewCommit : "",
    reviewTitle: typeof candidate.reviewTitle === "string" ? candidate.reviewTitle : "",
    sandbox: safeSandbox,
    approvalPolicy: normalizeApprovalPolicy(candidate.approvalPolicy),
    webSearch: Boolean(candidate.webSearch),
    profile: typeof candidate.profile === "string" ? candidate.profile : "",
    configFlags,
    enableFlags,
    disableFlags,
    addDirs,
    skipGitRepoCheck:
      typeof candidate.skipGitRepoCheck === "boolean"
        ? candidate.skipGitRepoCheck
        : true,
    ephemeral: Boolean(candidate.ephemeral),
    jsonOutput:
      typeof candidate.jsonOutput === "boolean" ? candidate.jsonOutput : true,
    imagePaths: Array.isArray(candidate.imagePaths) ? candidate.imagePaths.filter((path): path is string => typeof path === "string" && path.trim() !== "") : [],
    activeJobID: typeof candidate.activeJobID === "string" ? candidate.activeJobID : "",
    lastJobStatus: safeLast,
    unreadDone: Boolean(candidate.unreadDone),
    pinned: Boolean(candidate.pinned)
  };
}

function normalizeWorkspace(raw: unknown, index: number): WorkspaceDirectory {
  const fallback = createWorkspace(index, DEFAULT_PROJECT_PATH);
  if (!raw || typeof raw !== "object") return fallback;
  const candidate = raw as Partial<WorkspaceDirectory>;
  const now = new Date().toISOString();
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions.map((thread, threadIndex) => normalizeSession(thread, threadIndex + 1))
    : [];
  const safeSessions = sessions;
  const activeSessionID =
    typeof candidate.activeSessionID === "string" && safeSessions.some((thread) => thread.id === candidate.activeSessionID)
      ? candidate.activeSessionID
      : safeSessions[0]?.id ?? "";

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : fallback.id,
    hostID: typeof candidate.hostID === "string" ? candidate.hostID : fallback.hostID,
    hostName: typeof candidate.hostName === "string" && candidate.hostName.trim() ? candidate.hostName : fallback.hostName,
    path: typeof candidate.path === "string" && candidate.path.trim() ? candidate.path : DEFAULT_PROJECT_PATH,
    title:
      typeof candidate.title === "string" && candidate.title.trim()
        ? candidate.title.trim()
        : projectTitleFromPath(
            typeof candidate.path === "string" && candidate.path.trim()
              ? candidate.path
              : DEFAULT_PROJECT_PATH,
          ),
    sessions: safeSessions,
    activeSessionID,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now
  };
}

function loadPersistedState(): PersistedSessionState {
  const fallback = defaultState();
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(SESSION_STATE_KEY);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionState>;
    if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) return fallback;
    const workspaces = parsed.workspaces.map((workspace, index) => normalizeWorkspace(workspace, index + 1));
    const activeWorkspaceID =
      typeof parsed.activeWorkspaceID === "string" && workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceID)
        ? parsed.activeWorkspaceID
        : workspaces[0].id;
    return { workspaces, activeWorkspaceID };
  } catch {
    return fallback;
  }
}

export function useSessionDomain() {
  const initial = useMemo(() => loadPersistedState(), []);
  const initialWorkspace = initial.workspaces.find((workspace) => workspace.id === initial.activeWorkspaceID) ?? initial.workspaces[0] ?? null;
  const initialThread = initialWorkspace
    ? initialWorkspace.sessions.find((thread) => thread.id === initialWorkspace.activeSessionID) ?? initialWorkspace.sessions[0] ?? null
    : null;

  const [workspaces, setWorkspaces] = useState<WorkspaceDirectory[]>(initial.workspaces);
  const [activeWorkspaceID, setActiveWorkspaceID] = useState<string>(initial.activeWorkspaceID);
  const [threadRenameDraft, setThreadRenameDraft] = useState(initialThread?.title ?? "Session 1");
  const [workspacePathDraft, setWorkspacePathDraft] = useState(initialWorkspace?.path ?? DEFAULT_PROJECT_PATH);
  const [workspaceAddDraft, setWorkspaceAddDraft] = useState("");
  const [activeJobThreadID, setActiveJobThreadID] = useState(initialThread?.id ?? "");

  const completedJobsRef = useRef<Set<string>>(new Set());
  const entryCounter = useRef(0);
  const sessionCounterRef = useRef(Math.max(1, initial.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0)));
  const workspaceCounterRef = useRef(Math.max(1, initial.workspaces.length));

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceID) ?? workspaces[0] ?? null,
    [workspaces, activeWorkspaceID]
  );

  const threads = activeWorkspace?.sessions ?? [];
  const activeThreadID = activeWorkspace?.activeSessionID ?? "";

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadID) ?? threads[0] ?? null,
    [threads, activeThreadID]
  );

  const activeTimeline = activeThread?.timeline ?? [];
  const activeDraft = activeThread?.draft ?? "";

  const runningThreadJobs = useMemo(() => {
    const out: Array<{ threadID: string; jobID: string }> = [];
    for (const workspace of workspaces) {
      for (const thread of workspace.sessions) {
        if (!thread.activeJobID) continue;
        out.push({ threadID: thread.id, jobID: thread.activeJobID });
      }
    }
    return out;
  }, [workspaces]);

  useEffect(() => {
    if (!activeWorkspace && workspaces.length > 0) {
      setActiveWorkspaceID(workspaces[0].id);
      return;
    }
    if (activeWorkspace) {
      setWorkspacePathDraft(activeWorkspace.path);
    }
  }, [activeWorkspace, workspaces]);

  useEffect(() => {
    setThreadRenameDraft(activeThread?.title ?? "");
  }, [activeThreadID, activeThread?.title]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload: PersistedSessionState = {
      workspaces,
      activeWorkspaceID
    };
    window.localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(payload));
  }, [workspaces, activeWorkspaceID]);

  function nextEntryID(): string {
    entryCounter.current += 1;
    return `entry_${Date.now()}_${entryCounter.current}`;
  }

  function updateWorkspacesByThread(
    threadID: string,
    updater: (thread: ConversationThread) => ConversationThread,
  ) {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        let touched = false;
        const nextSessions = workspace.sessions.map((thread) => {
          if (thread.id !== threadID) return thread;
          const nextThread = updater(thread);
          if (nextThread !== thread) touched = true;
          return nextThread;
        });
        if (!touched) return workspace;
        return {
          ...workspace,
          sessions: nextSessions,
          updatedAt: new Date().toISOString()
        };
      })
    );
  }

  function setActiveThreadID(threadID: string) {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.id !== activeWorkspaceID) return workspace;
        if (!workspace.sessions.some((thread) => thread.id === threadID)) return workspace;
        return {
          ...workspace,
          activeSessionID: threadID,
          sessions: workspace.sessions.map((thread) =>
            thread.id === threadID
              ? {
                  ...thread,
                  unreadDone: false
                }
              : thread
          )
        };
      })
    );
  }

  function activateThread(threadID: string) {
    const workspace = workspaces.find((item) => item.sessions.some((thread) => thread.id === threadID));
    if (!workspace) return;
    setActiveWorkspaceID(workspace.id);
    setWorkspaces((prev) =>
      prev.map((item) => {
        if (item.id !== workspace.id) return item;
        return {
          ...item,
          activeSessionID: threadID,
          sessions: item.sessions.map((thread) =>
            thread.id === threadID
              ? {
                  ...thread,
                  unreadDone: false
                }
              : thread
          )
        };
      })
    );
  }

  function updateThreadDraft(threadID: string, draft: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      draft,
      updatedAt: new Date().toISOString()
    }));
  }

  function addTimelineEntry(entry: Omit<TimelineEntry, "id" | "createdAt">, threadID = activeThreadID) {
    const createdAt = new Date().toISOString();
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      timeline: [
        ...thread.timeline,
        {
          id: nextEntryID(),
          createdAt,
          ...entry
        }
      ],
      updatedAt: createdAt
    }));
  }

  function upsertAssistantStreamEntry(threadID: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    updateWorkspacesByThread(threadID, (thread) => {
      const timeline = [...thread.timeline];
      let runningIndex = -1;
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const candidate = timeline[index];
        if (candidate.kind === "assistant" && candidate.state === "running") {
          runningIndex = index;
          break;
        }
      }
      if (runningIndex >= 0) {
        const running = timeline[runningIndex];
        if (running.body === trimmed) return thread;
        timeline[runningIndex] = {
          ...running,
          body: trimmed
        };
      } else {
        timeline.push({
          id: nextEntryID(),
          kind: "assistant",
          state: "running",
          title: "Assistant",
          body: trimmed,
          createdAt: now
        });
      }
      return {
        ...thread,
        timeline,
        updatedAt: now
      };
    });
  }

  function finalizeAssistantStreamEntry(threadID: string, state: "success" | "error", body?: string) {
    const trimmed = body?.trim() ?? "";
    const now = new Date().toISOString();
    updateWorkspacesByThread(threadID, (thread) => {
      const timeline = [...thread.timeline];
      let runningIndex = -1;
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const candidate = timeline[index];
        if (candidate.kind === "assistant" && candidate.state === "running") {
          runningIndex = index;
          break;
        }
      }
      if (runningIndex >= 0) {
        const running = timeline[runningIndex];
        timeline[runningIndex] = {
          ...running,
          state,
          body: trimmed || running.body
        };
        return {
          ...thread,
          timeline,
          updatedAt: now
        };
      }
      if (!trimmed) return thread;
      timeline.push({
        id: nextEntryID(),
        kind: "assistant",
        state,
        title: "Assistant",
        body: trimmed,
        createdAt: now
      });
      return {
        ...thread,
        timeline,
        updatedAt: now
      };
    });
  }

  function createThread() {
    if (!activeWorkspaceID) return;
    sessionCounterRef.current += 1;
    const idx = sessionCounterRef.current;
    const next = createSession(idx, `Session ${idx}`);
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (workspace.id !== activeWorkspaceID) return workspace;
        return {
          ...workspace,
          sessions: [...workspace.sessions, next],
          activeSessionID: next.id,
          updatedAt: new Date().toISOString()
        };
      })
    );
    setThreadRenameDraft(next.title);
  }

  function forkThread(threadID: string) {
    const sourceID = threadID.trim();
    if (!sourceID) return;
    const workspace = workspaces.find((item) =>
      item.sessions.some((thread) => thread.id === sourceID),
    );
    if (!workspace) return;
    const source = workspace.sessions.find((thread) => thread.id === sourceID);
    if (!source) return;

    sessionCounterRef.current += 1;
    const idx = sessionCounterRef.current;
    const forked = createForkSession(source, idx);

    setWorkspaces((prev) =>
      prev.map((item) => {
        if (item.id !== workspace.id) return item;
        return {
          ...item,
          sessions: [...item.sessions, forked],
          activeSessionID: forked.id,
          updatedAt: new Date().toISOString()
        };
      })
    );
    setActiveWorkspaceID(workspace.id);
    setThreadRenameDraft(forked.title);
  }

  function removeThread(threadID: string) {
    const targetID = threadID.trim();
    if (!targetID) return;
    let removed = false;
    let nextActiveWorkspaceID = activeWorkspaceID;
    let fallbackThreadID = "";
    setWorkspaces((prev) => {
      const now = new Date().toISOString();
      const next = prev.map((workspace) => {
        const currentIndex = workspace.sessions.findIndex((thread) => thread.id === targetID);
        if (currentIndex < 0) return workspace;
        removed = true;

        const nextSessions = workspace.sessions.filter((thread) => thread.id !== targetID);
        let nextActiveSessionID = workspace.activeSessionID;
        if (workspace.activeSessionID === targetID) {
          if (nextSessions.length > 0) {
            const fallbackIndex = Math.min(currentIndex, nextSessions.length - 1);
            nextActiveSessionID = nextSessions[fallbackIndex]?.id ?? "";
          } else {
            nextActiveSessionID = "";
          }
        }
        return {
          ...workspace,
          sessions: nextSessions,
          activeSessionID: nextActiveSessionID,
          updatedAt: now
        };
      });

      if (!removed) {
        return prev;
      }
      if (!next.some((workspace) => workspace.id === nextActiveWorkspaceID)) {
        nextActiveWorkspaceID = next[0]?.id ?? "";
      }
      const nextActiveWorkspace = next.find((workspace) => workspace.id === nextActiveWorkspaceID);
      fallbackThreadID = nextActiveWorkspace?.activeSessionID ?? "";
      return next;
    });
    if (!removed) return;
    if (nextActiveWorkspaceID !== activeWorkspaceID) {
      setActiveWorkspaceID(nextActiveWorkspaceID);
    }
    if (activeJobThreadID === targetID) {
      setActiveJobThreadID(fallbackThreadID);
    }
  }

  function renameThread(threadID: string, nextTitle: string) {
    const trimmed = nextTitle.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      title: trimmed,
      updatedAt: new Date().toISOString()
    }));
    setThreadRenameDraft(trimmed);
  }

  function switchThreadByOffset(offset: number) {
    if (threads.length === 0) return;
    const currentIndex = Math.max(0, threads.findIndex((thread) => thread.id === activeThreadID));
    const nextIndex = (currentIndex + offset + threads.length) % threads.length;
    setActiveThreadID(threads[nextIndex].id);
  }

  function addWorkspace(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    workspaceCounterRef.current += 1;
    const idx = workspaceCounterRef.current;
    const workspace = createWorkspace(idx, trimmed);
    setWorkspaces((prev) => [...prev, workspace]);
    setActiveWorkspaceID(workspace.id);
    setWorkspaceAddDraft("");
    setWorkspacePathDraft(trimmed);
    setThreadRenameDraft(workspace.sessions[0].title);
  }

  function updateActiveWorkspacePath(path: string) {
    const trimmed = path.trim();
    if (!activeWorkspaceID || !trimmed) return;
    setWorkspaces((prev) =>
      prev.map((workspace) =>
        workspace.id === activeWorkspaceID
          ? {
              ...workspace,
              path: trimmed,
              updatedAt: new Date().toISOString()
            }
          : workspace
      )
    );
    setWorkspacePathDraft(trimmed);
  }

  function setThreadModel(threadID: string, model: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      model,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadCodexMode(threadID: string, mode: CodexSessionMode) {
    const safeMode = normalizeSessionMode(mode);
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      codexMode: safeMode,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadResumeLast(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      resumeLast: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadResumeSessionID(threadID: string, sessionID: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      resumeSessionID: sessionID,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadReviewUncommitted(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      reviewUncommitted: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadReviewBase(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      reviewBase: value,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadReviewCommit(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      reviewCommit: value,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadReviewTitle(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      reviewTitle: value,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadSandbox(threadID: string, sandbox: "" | "read-only" | "workspace-write" | "danger-full-access") {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      sandbox,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadApprovalPolicy(threadID: string, policy: CodexApprovalPolicy) {
    const safePolicy = normalizeApprovalPolicy(policy);
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      approvalPolicy: safePolicy,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadWebSearch(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      webSearch: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadProfile(threadID: string, profile: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      profile,
      updatedAt: new Date().toISOString()
    }));
  }

  function addThreadConfigFlag(threadID: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.configFlags.includes(trimmed)) return thread;
      return {
        ...thread,
        configFlags: [...thread.configFlags, trimmed],
        updatedAt: new Date().toISOString()
      };
    });
  }

  function removeThreadConfigFlag(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      configFlags: thread.configFlags.filter((item) => item !== value),
      updatedAt: new Date().toISOString()
    }));
  }

  function addThreadEnableFlag(threadID: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.enableFlags.includes(trimmed)) return thread;
      return {
        ...thread,
        enableFlags: [...thread.enableFlags, trimmed],
        updatedAt: new Date().toISOString()
      };
    });
  }

  function removeThreadEnableFlag(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      enableFlags: thread.enableFlags.filter((item) => item !== value),
      updatedAt: new Date().toISOString()
    }));
  }

  function addThreadDisableFlag(threadID: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.disableFlags.includes(trimmed)) return thread;
      return {
        ...thread,
        disableFlags: [...thread.disableFlags, trimmed],
        updatedAt: new Date().toISOString()
      };
    });
  }

  function removeThreadDisableFlag(threadID: string, value: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      disableFlags: thread.disableFlags.filter((item) => item !== value),
      updatedAt: new Date().toISOString()
    }));
  }

  function addThreadAddDir(threadID: string, dir: string) {
    const trimmed = dir.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.addDirs.includes(trimmed)) return thread;
      return {
        ...thread,
        addDirs: [...thread.addDirs, trimmed],
        updatedAt: new Date().toISOString()
      };
    });
  }

  function removeThreadAddDir(threadID: string, dir: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      addDirs: thread.addDirs.filter((item) => item !== dir),
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadSkipGitRepoCheck(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      skipGitRepoCheck: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadEphemeral(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      ephemeral: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadJSONOutput(threadID: string, enabled: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      jsonOutput: enabled,
      updatedAt: new Date().toISOString()
    }));
  }

  function addThreadImagePath(threadID: string, imagePath: string) {
    const trimmed = imagePath.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      imagePaths: [...thread.imagePaths, trimmed],
      updatedAt: new Date().toISOString()
    }));
  }

  function removeThreadImagePath(threadID: string, imagePath: string) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      imagePaths: thread.imagePaths.filter((path) => path !== imagePath),
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadJobState(threadID: string, jobID: string, status?: ConversationThread["lastJobStatus"]) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      activeJobID: jobID,
      lastJobStatus: status ?? (jobID ? "running" : thread.lastJobStatus),
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadUnread(threadID: string, unreadDone: boolean) {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      unreadDone,
      updatedAt: new Date().toISOString()
    }));
  }

  function setThreadTitle(threadID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.title.trim() === trimmed) return thread;
      return {
        ...thread,
        title: trimmed,
        updatedAt: new Date().toISOString()
      };
    });
  }

  function setThreadPinned(threadID: string, pinned: boolean) {
    updateWorkspacesByThread(threadID, (thread) => {
      if (thread.pinned === pinned) return thread;
      return {
        ...thread,
        pinned,
        updatedAt: new Date().toISOString()
      };
    });
  }

  function syncProjectsFromDiscovery(
    projects: DiscoveredProject[],
    options?: SyncProjectsOptions,
  ) {
    const preserveMissingSessions = options?.preserveMissingSessions !== false;
    const now = new Date().toISOString();
    const currentByThreadID = new Map<string, ConversationThread>();
    const currentByWorkspaceID = new Map<string, WorkspaceDirectory>();
    const incomingHostIDs = new Set<string>();
    for (const workspace of workspaces) {
      currentByWorkspaceID.set(workspace.id, workspace);
      for (const thread of workspace.sessions) {
        currentByThreadID.set(thread.id, thread);
      }
    }

    const nextWorkspaces: WorkspaceDirectory[] = [];
    for (const project of projects) {
      const hostID = project.hostID.trim();
      const path = project.path.trim();
      if (!hostID || !path) continue;
      incomingHostIDs.add(hostID);

      const id = project.id?.trim() || projectWorkspaceID(hostID, path);
      const existing = currentByWorkspaceID.get(id);
      const seen = new Set<string>();
      const sessions: ConversationThread[] = [];
      const projectTitle =
        project.title?.trim() ||
        existing?.title?.trim() ||
        projectTitleFromPath(path);

      for (const discovered of project.sessions) {
        const sessionID = discovered.id.trim();
        if (!sessionID || seen.has(sessionID)) continue;
        seen.add(sessionID);
        const prior = currentByThreadID.get(sessionID);
        const title = discovered.title.trim() || prior?.title || sessionID;
        const createdAt = prior?.createdAt ?? discovered.updatedAt ?? now;
        const updatedAt = discovered.updatedAt ?? prior?.updatedAt ?? now;
        sessions.push({
          id: sessionID,
          title,
          draft: prior?.draft ?? "",
          timeline: prior?.timeline ?? [],
          createdAt,
          updatedAt,
          model: prior?.model ?? "",
          codexMode: prior?.codexMode ?? "exec",
          resumeLast: prior?.resumeLast ?? true,
          resumeSessionID: prior?.resumeSessionID ?? "",
          reviewUncommitted: prior?.reviewUncommitted ?? false,
          reviewBase: prior?.reviewBase ?? "",
          reviewCommit: prior?.reviewCommit ?? "",
          reviewTitle: prior?.reviewTitle ?? "",
          sandbox: prior?.sandbox ?? "workspace-write",
          approvalPolicy: prior?.approvalPolicy ?? "",
          webSearch: prior?.webSearch ?? false,
          profile: prior?.profile ?? "",
          configFlags: prior?.configFlags ?? [],
          enableFlags: prior?.enableFlags ?? [],
          disableFlags: prior?.disableFlags ?? [],
          addDirs: prior?.addDirs ?? [],
          skipGitRepoCheck: prior?.skipGitRepoCheck ?? true,
          ephemeral: prior?.ephemeral ?? false,
          jsonOutput: prior?.jsonOutput ?? true,
          imagePaths: prior?.imagePaths ?? [],
          activeJobID: prior?.activeJobID ?? "",
          lastJobStatus: prior?.lastJobStatus ?? "idle",
          unreadDone: prior?.unreadDone ?? false,
          pinned: prior?.pinned ?? false
        });
      }

      if (existing && preserveMissingSessions) {
        for (const prior of existing.sessions) {
          if (seen.has(prior.id)) continue;
          sessions.push(prior);
          seen.add(prior.id);
        }
      }

      const activeSessionID =
        existing && sessions.some((thread) => thread.id === existing.activeSessionID)
          ? existing.activeSessionID
          : sessions[0]?.id ?? "";

      nextWorkspaces.push({
        id,
        hostID,
        hostName: project.hostName.trim() || existing?.hostName || hostID,
        path,
        title: projectTitle,
        sessions,
        activeSessionID,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
    }

    for (const existing of workspaces) {
      if (nextWorkspaces.some((workspace) => workspace.id === existing.id)) continue;
      const hostID = existing.hostID.trim();
      if (incomingHostIDs.size > 0 && hostID && !incomingHostIDs.has(hostID)) continue;
      nextWorkspaces.push({
        ...existing,
        updatedAt: now
      });
    }

    if (nextWorkspaces.length === 0) {
      if (workspaces.length > 0) {
        return;
      }
      const fallback = createWorkspace(1, DEFAULT_PROJECT_PATH);
      setWorkspaces([fallback]);
      setActiveWorkspaceID(fallback.id);
      setActiveJobThreadID(fallback.sessions[0]?.id ?? "");
      return;
    }

    const nextActiveWorkspaceID = nextWorkspaces.some((workspace) => workspace.id === activeWorkspaceID)
      ? activeWorkspaceID
      : nextWorkspaces[0].id;
    setWorkspaces(nextWorkspaces);
    setActiveWorkspaceID(nextActiveWorkspaceID);
    const activeProject = nextWorkspaces.find((workspace) => workspace.id === nextActiveWorkspaceID) ?? nextWorkspaces[0];
    setActiveJobThreadID(activeProject?.activeSessionID ?? "");
  }

  function resetSessionDomain() {
    const fresh = createWorkspace(1, DEFAULT_PROJECT_PATH);
    completedJobsRef.current.clear();
    workspaceCounterRef.current = 1;
    sessionCounterRef.current = 1;
    setWorkspaces([fresh]);
    setActiveWorkspaceID(fresh.id);
    setActiveJobThreadID(fresh.sessions[0].id);
    setThreadRenameDraft(fresh.sessions[0].title);
    setWorkspacePathDraft(fresh.path);
    setWorkspaceAddDraft("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(SESSION_STATE_KEY);
    }
  }

  return {
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
    runningThreadJobs,
    updateThreadDraft,
    addTimelineEntry,
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    createThread,
    forkThread,
    removeThread,
    renameThread,
    switchThreadByOffset,
    setThreadModel,
    setThreadCodexMode,
    setThreadResumeLast,
    setThreadResumeSessionID,
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
    syncProjectsFromDiscovery,
    resetSessionDomain
  };
}
