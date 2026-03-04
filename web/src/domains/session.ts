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
  pinned: boolean;
};

export type WorkspaceDirectory = {
  id: string;
  hostID: string;
  hostName: string;
  path: string;
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
  hostID: string;
  hostName: string;
  path: string;
  sessions: DiscoveredProjectSession[];
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
    unreadDone: false,
    pinned: false
  };
}

function createWorkspace(index: number, path: string, hostID = "local", hostName = "local-default"): WorkspaceDirectory {
  const now = new Date().toISOString();
  const first = createSession(index, "Session 1");
  return {
    id: `workspace_${Date.now()}_${index}`,
    hostID,
    hostName,
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
    unreadDone: Boolean(candidate.unreadDone),
    pinned: Boolean(candidate.pinned)
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
  const safeSessions = sessions;
  const activeSessionID =
    typeof candidate.activeSessionID === "string" && safeSessions.some((thread) => thread.id === candidate.activeSessionID)
      ? candidate.activeSessionID
      : safeSessions[0]?.id ?? "";

  return {
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : fallback.id,
    hostID: typeof candidate.hostID === "string" ? candidate.hostID : fallback.hostID,
    hostName: typeof candidate.hostName === "string" && candidate.hostName.trim() ? candidate.hostName : fallback.hostName,
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
      const last = timeline[timeline.length - 1];
      if (last && last.kind === "assistant" && last.state === "running") {
        if (last.body === trimmed) return thread;
        timeline[timeline.length - 1] = {
          ...last,
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
      const last = timeline[timeline.length - 1];
      if (last && last.kind === "assistant" && last.state === "running") {
        timeline[timeline.length - 1] = {
          ...last,
          state,
          body: trimmed || last.body
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

  function syncProjectsFromDiscovery(projects: DiscoveredProject[]) {
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

      const id = projectWorkspaceID(hostID, path);
      const existing = currentByWorkspaceID.get(id);
      const seen = new Set<string>();
      const sessions: ConversationThread[] = [];

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
          sandbox: prior?.sandbox ?? "workspace-write",
          imagePaths: prior?.imagePaths ?? [],
          activeJobID: prior?.activeJobID ?? "",
          lastJobStatus: prior?.lastJobStatus ?? "idle",
          unreadDone: prior?.unreadDone ?? false,
          pinned: prior?.pinned ?? false
        });
      }

      if (existing) {
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
      const fallback = createWorkspace(1, "/home/ecs-user");
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
    upsertAssistantStreamEntry,
    finalizeAssistantStreamEntry,
    createThread,
    removeThread,
    renameThread,
    switchThreadByOffset,
    setThreadModel,
    setThreadSandbox,
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
