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
};

function createInitialThread(): ConversationThread {
  const now = new Date().toISOString();
  return {
    id: "thread_1",
    title: "Thread 1",
    draft: "summarize current repo state and risks",
    timeline: [],
    createdAt: now,
    updatedAt: now
  };
}

export function useSessionDomain() {
  const [threads, setThreads] = useState<ConversationThread[]>(() => [createInitialThread()]);
  const [activeThreadID, setActiveThreadID] = useState("thread_1");
  const [threadRenameDraft, setThreadRenameDraft] = useState("Thread 1");
  const [activeJobThreadID, setActiveJobThreadID] = useState("thread_1");

  const completedJobsRef = useRef<Set<string>>(new Set());
  const entryCounter = useRef(0);
  const threadCounterRef = useRef(1);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadID) ?? threads[0] ?? null,
    [threads, activeThreadID]
  );

  const activeTimeline = activeThread?.timeline ?? [];
  const activeDraft = activeThread?.draft ?? "";

  useEffect(() => {
    if (!threads.some((thread) => thread.id === activeThreadID) && threads.length > 0) {
      setActiveThreadID(threads[0].id);
    }
  }, [threads, activeThreadID]);

  useEffect(() => {
    setThreadRenameDraft(activeThread?.title ?? "");
  }, [activeThreadID, activeThread?.title]);

  function nextEntryID(): string {
    entryCounter.current += 1;
    return `entry_${Date.now()}_${entryCounter.current}`;
  }

  function updateThreadDraft(threadID: string, draft: string) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadID
          ? {
              ...thread,
              draft,
              updatedAt: new Date().toISOString()
            }
          : thread
      )
    );
  }

  function addTimelineEntry(entry: Omit<TimelineEntry, "id" | "createdAt">, threadID = activeThreadID) {
    const createdAt = new Date().toISOString();
    setThreads((prev) =>
      prev.map((thread) => {
        if (thread.id !== threadID) return thread;
        return {
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
        };
      })
    );
  }

  function createThread() {
    threadCounterRef.current += 1;
    const idx = threadCounterRef.current;
    const now = new Date().toISOString();
    const next: ConversationThread = {
      id: `thread_${Date.now()}_${idx}`,
      title: `Thread ${idx}`,
      draft: "",
      timeline: [],
      createdAt: now,
      updatedAt: now
    };
    setThreads((prev) => [...prev, next]);
    setActiveThreadID(next.id);
    setThreadRenameDraft(next.title);
  }

  function renameThread(threadID: string, nextTitle: string) {
    const trimmed = nextTitle.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    setThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadID
          ? {
              ...thread,
              title: trimmed,
              updatedAt: now
            }
          : thread
      )
    );
    setThreadRenameDraft(trimmed);
  }

  function switchThreadByOffset(offset: number) {
    if (threads.length === 0) return;
    const currentIndex = Math.max(
      0,
      threads.findIndex((thread) => thread.id === activeThreadID)
    );
    const nextIndex = (currentIndex + offset + threads.length) % threads.length;
    setActiveThreadID(threads[nextIndex].id);
  }

  function resetSessionDomain() {
    const initial = createInitialThread();
    completedJobsRef.current.clear();
    threadCounterRef.current = 1;
    setThreads([initial]);
    setActiveThreadID(initial.id);
    setActiveJobThreadID(initial.id);
    setThreadRenameDraft(initial.title);
  }

  return {
    threads,
    setThreads,
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
  };
}
