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

export function useSessionDomain() {
  const [workspaces, setWorkspaces] = useState<WorkspaceDirectory[]>(() => [createWorkspace(1, "/home/ecs-user")]);
  const [activeWorkspaceID, setActiveWorkspaceID] = useState<string>(() => workspaces[0]?.id ?? "");
  const [threadRenameDraft, setThreadRenameDraft] = useState("Session 1");
  const [workspacePathDraft, setWorkspacePathDraft] = useState("/home/ecs-user");
  const [workspaceAddDraft, setWorkspaceAddDraft] = useState("");
  const [activeJobThreadID, setActiveJobThreadID] = useState("");

  const completedJobsRef = useRef<Set<string>>(new Set());
  const entryCounter = useRef(0);
  const sessionCounterRef = useRef(1);
  const workspaceCounterRef = useRef(1);

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
    const initial = createWorkspace(1, "/home/ecs-user");
    completedJobsRef.current.clear();
    workspaceCounterRef.current = 1;
    sessionCounterRef.current = 1;
    setWorkspaces([initial]);
    setActiveWorkspaceID(initial.id);
    setActiveJobThreadID(initial.sessions[0].id);
    setThreadRenameDraft(initial.sessions[0].title);
    setWorkspacePathDraft(initial.path);
    setWorkspaceAddDraft("");
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
