import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import { archiveCodexV2Session, type Host } from "../../api";
import type {
  ConversationThread,
  TimelineEntry,
} from "../../domains/session";
import type { SessionRunStreamState, SessionStreamHealthState } from "./stream-types";

type CreateSessionControlActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThread: ConversationThread | null;
  activeThreadID: string;
  submittingThreadID: string;
  activeWorkspaceHostID: string;
  activeWorkspaceHostName: string;
  hosts: Host[];

  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;

  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  removeThread: (threadID: string) => void;
  stopSessionStream: (
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) => void;
  deleteSessionEventCursor: (sessionID: string) => void;
  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;
  updateSessionStreamHealth: (
    sessionID: string,
    state: SessionStreamHealthState,
    options?: {
      retries?: number;
      lastEventAt?: number;
      lastError?: string;
      throttleMS?: number;
    },
  ) => void;
  startSessionStream: (sessionID: string, authToken: string) => void;
  loadWorkspace: (authToken: string) => Promise<void>;
  isLocalDraftSessionID: (sessionID: string) => boolean;

  setDeletingThreadID: Dispatch<SetStateAction<string>>;
};

export function createSessionControlActions(
  deps: CreateSessionControlActionsDeps,
) {
  const canRun = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const onRefreshWorkspace = async () => {
    if (!canRun()) return;
    await deps.loadWorkspace(deps.token);
  };

  const onArchiveActiveSession = async () => {
    if (!canRun() || !deps.activeThread) return;
    const targetSessionID = deps.activeThread.id.trim();
    if (!targetSessionID) return;
    if (
      deps.activeThread.activeJobID ||
      deps.submittingThreadID === targetSessionID
    ) {
      deps.addTimelineEntry(
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
      `Archive session "${deps.activeThread.title}" on host "${deps.activeWorkspaceHostName || "unknown"}"?`,
    );
    if (!confirmed) return;
    if (deps.isLocalDraftSessionID(targetSessionID)) {
      deps.removeThread(targetSessionID);
      return;
    }

    deps.setDeletingThreadID(targetSessionID);
    try {
      await archiveCodexV2Session(deps.token, targetSessionID, {
        host_id: deps.activeWorkspaceHostID || undefined,
      });
      deps.stopSessionStream(targetSessionID);
      deps.deleteSessionEventCursor(targetSessionID);
      deps.sessionRunStateRef.current.delete(targetSessionID);
      deps.removeThread(targetSessionID);
      await deps.refreshProjectsFromSource(deps.token, deps.hosts, false, true);
    } catch (error) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Archive Failed",
          body: String(error),
        },
        targetSessionID,
      );
    } finally {
      deps.setDeletingThreadID("");
    }
  };

  const onReconnectActiveStream = () => {
    if (!canRun()) return;
    const sessionID = deps.activeThreadID.trim();
    if (!sessionID) return;
    deps.stopSessionStream(sessionID, {
      preserveRunState: true,
      preserveHealth: true,
    });
    deps.updateSessionStreamHealth(sessionID, "connecting", {
      throttleMS: 0,
      lastError: "",
    });
    deps.startSessionStream(sessionID, deps.token);
  };

  return {
    onRefreshWorkspace,
    onArchiveActiveSession,
    onReconnectActiveStream,
  };
}
