import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { startCodexV2Review, startCodexV2Session, type Host } from "../../api";
import type { TimelineEntry, ConversationThread } from "../../domains/session";
import {
  extractTurnIDFromPayload,
  extractThreadIDFromCodexSessionResponse,
} from "./codex-parsing";
import { ensureSessionRunState } from "./session-run-events";
import type { SessionStreamRuntimeState } from "./session-stream-controller";
import type { SessionRunStreamState } from "./stream-types";

type CreateSessionReviewActionDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThread: ConversationThread | null;
  submittingThreadID: string;
  activeWorkspaceHostID: string;
  activeWorkspacePath: string;
  hosts: Host[];
  selectedHostIDs: string[];

  activeThreadIDRef: MutableRefObject<string>;
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;
  sessionStreamStateRef: MutableRefObject<
    Map<string, SessionStreamRuntimeState>
  >;

  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  bindThreadID: (
    previousThreadID: string,
    nextThreadID: string,
    options?: { title?: string },
  ) => string;
  stopSessionStream: (
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) => void;
  deleteSessionEventCursor: (sessionID: string) => void;
  setThreadJobState: (
    threadID: string,
    jobID: string,
    status?: ConversationThread["lastJobStatus"],
  ) => void;
  setActiveJobThreadID: Dispatch<SetStateAction<string>>;
  setActiveJobID: Dispatch<SetStateAction<string>>;
  startSessionStream: (sessionID: string, authToken: string) => void;
  setSubmittingThreadID: Dispatch<SetStateAction<string>>;
  setThreadCodexMode: (
    threadID: string,
    mode: ConversationThread["codexMode"],
  ) => void;
  isLocalDraftSessionID: (sessionID: string) => boolean;
};

function reviewInstructions(thread: ConversationThread): string | undefined {
  const title = thread.reviewTitle.trim();
  if (thread.reviewUncommitted) return undefined;
  if (thread.reviewBase.trim()) return undefined;
  if (thread.reviewCommit.trim()) return undefined;
  return title || undefined;
}

export function createSessionReviewAction(deps: CreateSessionReviewActionDeps) {
  const startReviewForActiveThread = async () => {
    if (
      deps.authPhase !== "ready" ||
      !deps.token.trim() ||
      !deps.activeThread
    ) {
      return;
    }
    if (
      deps.activeThread.activeJobID ||
      deps.submittingThreadID === deps.activeThread.id
    ) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Session Busy",
          body: "This session is already running. Wait for completion before starting another review.",
        },
        deps.activeThread.id,
      );
      return;
    }

    if (
      !deps.activeThread.reviewUncommitted &&
      !deps.activeThread.reviewBase.trim() &&
      !deps.activeThread.reviewCommit.trim() &&
      !deps.activeThread.reviewTitle.trim()
    ) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Review Scope Missing",
          body: "Set uncommitted changes, a base branch, a commit, or review instructions before starting review.",
        },
        deps.activeThread.id,
      );
      return;
    }

    const localHostIDs = deps.hosts
      .filter((host) => host.connection_mode === "local")
      .map((host) => host.id);
    const targetHostIDs =
      deps.activeWorkspaceHostID !== ""
        ? [deps.activeWorkspaceHostID]
        : deps.selectedHostIDs.length > 0
          ? deps.selectedHostIDs
          : localHostIDs.length > 0
            ? localHostIDs
            : deps.hosts.length > 0
              ? [deps.hosts[0].id]
              : [];
    const targetHostID = targetHostIDs[0]?.trim() ?? "";
    if (!targetHostID) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Server Available",
          body: "No server is available for this review.",
        },
        deps.activeThread.id,
      );
      return;
    }

    const effectiveWorkdir = deps.activeWorkspacePath || undefined;
    let targetThreadID = deps.activeThread.id;
    deps.setSubmittingThreadID(deps.activeThread.id);
    deps.setThreadCodexMode(deps.activeThread.id, "review");

    try {
      let sessionID = deps.activeThread.id.trim();
      if (deps.isLocalDraftSessionID(sessionID)) {
        const sessionResp = await startCodexV2Session(deps.token, {
          host_id: targetHostID,
          path: effectiveWorkdir,
          title: deps.activeThread.title,
          model: deps.activeThread.model.trim() || undefined,
          approval_policy: deps.activeThread.approvalPolicy || undefined,
          sandbox: deps.activeThread.sandbox || undefined,
        });
        const resolvedSessionID =
          extractThreadIDFromCodexSessionResponse(sessionResp) ||
          sessionResp.session.id.trim();
        if (!resolvedSessionID) {
          throw new Error("thread/start returned empty session id");
        }
        const previousSessionID = sessionID;
        sessionID = deps.bindThreadID(previousSessionID, resolvedSessionID, {
          title: sessionResp.session.title,
        });
        targetThreadID = sessionID;
        if (previousSessionID !== sessionID) {
          deps.stopSessionStream(previousSessionID, {
            preserveRunState: false,
            preserveHealth: false,
          });
          deps.deleteSessionEventCursor(previousSessionID);
          deps.sessionRunStateRef.current.delete(previousSessionID);
        }
      }

      const reviewResp = await startCodexV2Review(deps.token, sessionID, {
        host_id: targetHostID,
        path: effectiveWorkdir,
        title: deps.activeThread.title,
        review_uncommitted: deps.activeThread.reviewUncommitted || undefined,
        review_base: deps.activeThread.reviewBase.trim() || undefined,
        review_commit: deps.activeThread.reviewCommit.trim() || undefined,
        review_title: deps.activeThread.reviewTitle.trim() || undefined,
        instructions: reviewInstructions(deps.activeThread),
        delivery: "inline",
      });
      const runID =
        extractTurnIDFromPayload(reviewResp.turn ?? {}) ||
        `review_${Date.now()}`;
      ensureSessionRunState(deps.sessionRunStateRef, sessionID, runID);
      deps.setThreadJobState(sessionID, runID, "running");
      deps.setActiveJobThreadID(sessionID);
      if (sessionID === deps.activeThreadIDRef.current) {
        deps.setActiveJobID(runID);
      }
      if (!deps.sessionStreamStateRef.current.has(sessionID)) {
        deps.startSessionStream(sessionID, deps.token);
      }
      deps.setSubmittingThreadID("");
    } catch (error) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Review Failed",
          body: String(error),
        },
        targetThreadID,
      );
      deps.setThreadJobState(targetThreadID, "", "failed");
      deps.setSubmittingThreadID("");
    }
  };

  return {
    startReviewForActiveThread,
  };
}
