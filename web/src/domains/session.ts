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

export type ConversationThread = {
  id: string;
  title: string;
  draft: string;
  timeline: TimelineEntry[];
  createdAt: string;
  updatedAt: string;
  model: string;
  sandbox: "" | "read-only" | "workspace-write" | "danger-full-access";
  imagePaths: string[];
  activeJobID: string;
  lastJobStatus: "idle" | "running" | "succeeded" | "failed" | "canceled";
  unreadDone: boolean;
};

export type WorkspaceDirectory = {
  id: string;
  path: string;
  sessions: ConversationThread[];
  activeSessionID: string;
  createdAt: string;
  updatedAt: string;
};

type PersistedSessionState = {
  workspaces: WorkspaceDirectory[];
  activeWorkspaceID: string;
};

const SESSION_STATE_KEY = "remote_llm_session_state_v1";

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
    sandbox: "workspace-write",
    imagePaths: [],
    activeJobID: "",
    lastJobStatus: "idle",
    unreadDone: false
  };
}

function createWorkspace(index: number, path: string): WorkspaceDirectory {
  const now = new Date().toISOString();
  const first = createSession(index, "Session 1");
  return {
    id: `workspace_${Date.now()}_${index}`,
    path,
    sessions: [first],
    activeSessionID: first.id,
    createdAt: now,
    updatedAt: now
  };
}

function defaultState(): PersistedSessionState {
  const first = createWorkspace(1, "/home/ecs-user");
  return {
    workspaces: [first],
    activeWorkspaceID: first.id
  };
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

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : fallback.id,
    title: typeof candidate.title === "string" && candidate.title.trim() ? candidate.title : fallback.title,
    draft: typeof candidate.draft === "string" ? candidate.draft : "",
    timeline,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now,
    model: typeof candidate.model === "string" ? candidate.model : "",
    sandbox: safeSandbox,
    imagePaths: Array.isArray(candidate.imagePaths) ? candidate.imagePaths.filter((path): path is string => typeof path === "string" && path.trim() !== "") : [],
    activeJobID: typeof candidate.activeJobID === "string" ? candidate.activeJobID : "",
    lastJobStatus: safeLast,
    unreadDone: Boolean(candidate.unreadDone)
  };
}

function normalizeWorkspace(raw: unknown, index: number): WorkspaceDirectory {
  const fallback = createWorkspace(index, "/home/ecs-user");
  if (!raw || typeof raw !== "object") return fallback;
  const candidate = raw as Partial<WorkspaceDirectory>;
  const now = new Date().toISOString();
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions.map((thread, threadIndex) => normalizeSession(thread, threadIndex + 1))
    : [];
  const safeSessions = sessions.length > 0 ? sessions : [createSession(1, "Session 1")];
  const activeSessionID =
    typeof candidate.activeSessionID === "string" && safeSessions.some((thread) => thread.id === candidate.activeSessionID)
      ? candidate.activeSessionID
      : safeSessions[0].id;

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : fallback.id,
    path: typeof candidate.path === "string" && candidate.path.trim() ? candidate.path : "/home/ecs-user",
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
  const [workspacePathDraft, setWorkspacePathDraft] = useState(initialWorkspace?.path ?? "/home/ecs-user");
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

  function updateWorkspacesByThread(threadID: string, updater: (thread: ConversationThread) => ConversationThread) {
    setWorkspaces((prev) =>
      prev.map((workspace) => {
        if (!workspace.sessions.some((thread) => thread.id === threadID)) return workspace;
        const now = new Date().toISOString();
        return {
          ...workspace,
          sessions: workspace.sessions.map((thread) => (thread.id === threadID ? updater(thread) : thread)),
          updatedAt: now
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

  function setThreadSandbox(threadID: string, sandbox: "" | "read-only" | "workspace-write" | "danger-full-access") {
    updateWorkspacesByThread(threadID, (thread) => ({
      ...thread,
      sandbox,
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

  function resetSessionDomain() {
    const fresh = createWorkspace(1, "/home/ecs-user");
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
    createThread,
    renameThread,
    switchThreadByOffset,
    setThreadModel,
    setThreadSandbox,
    addThreadImagePath,
    removeThreadImagePath,
    setThreadJobState,
    setThreadUnread,
    resetSessionDomain
  };
}
