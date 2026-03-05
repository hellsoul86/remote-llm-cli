import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import {
  startCodexV2Session,
  startCodexV2Turn,
  type Host,
} from "../../api";
import type { TimelineEntry, ConversationThread } from "../../domains/session";
import {
  extractThreadIDFromCodexSessionResponse,
  extractTurnIDFromPayload,
} from "./codex-parsing";
import { ensureSessionRunState } from "./session-run-events";
import type { SessionStreamRuntimeState } from "./session-stream-controller";
import type { SessionRunStreamState } from "./stream-types";
import {
  deriveSessionTitleFromPrompt,
  isGenericSessionTitle,
} from "./utils";

type CreateSessionSubmitActionDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThread: ConversationThread | null;
  submittingThreadID: string;
  activeWorkspaceHostID: string;
  activeWorkspacePath: string;
  hosts: Host[];
  selectedHostIDs: string[];
  sessionModelDefault: string;
  sessionModelChoices: string[];
  runSandbox: "" | "read-only" | "workspace-write" | "danger-full-access";
  activeRuntimeName: string;
  selectedRuntime: string;

  activeThreadIDRef: MutableRefObject<string>;
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;
  sessionStreamStateRef: MutableRefObject<
    Map<string, SessionStreamRuntimeState>
  >;

  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  setThreadTitle: (threadID: string, title: string) => void;
  forceStickToBottom: () => void;
  updateThreadDraft: (threadID: string, draft: string) => void;
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
  finalizeAssistantStreamEntry: (
    threadID: string,
    state: "success" | "error",
    body?: string,
  ) => void;
  isLocalDraftSessionID: (sessionID: string) => boolean;
};

function normalizeStringList(values: string[]): string[] | undefined {
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
}

export function createSessionSubmitAction(deps: CreateSessionSubmitActionDeps) {
  const submitPromptForActiveThread = async (trimmedPrompt: string) => {
    if (deps.authPhase !== "ready" || !deps.token.trim() || !deps.activeThread) {
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
          body: "This session is already running. Wait for completion or switch to another session.",
        },
        deps.activeThread.id,
      );
      return;
    }

    const prompt = trimmedPrompt.trim();
    if (!prompt) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Prompt Missing",
          body: "Prompt is required.",
        },
        deps.activeThread.id,
      );
      return;
    }

    if (isGenericSessionTitle(deps.activeThread.title)) {
      const nextTitle = deriveSessionTitleFromPrompt(prompt);
      if (nextTitle) {
        deps.setThreadTitle(deps.activeThread.id, nextTitle);
      }
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

    if (targetHostIDs.length === 0) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "No Server Available",
          body: "No server is available for this session.",
        },
        deps.activeThread.id,
      );
      return;
    }

    const selectedHosts = deps.hosts.filter((host) =>
      targetHostIDs.includes(host.id),
    );
    const hasNonLocalTarget = selectedHosts.some(
      (host) => host.connection_mode !== "local",
    );
    const safeImagePaths = !hasNonLocalTarget ? deps.activeThread.imagePaths : [];
    if (hasNonLocalTarget && deps.activeThread.imagePaths.length > 0) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Image Attachment Skipped",
          body: "Image attachments are only applied to local-mode targets.",
        },
        deps.activeThread.id,
      );
    }

    const effectiveModel =
      deps.activeThread.model.trim() ||
      deps.sessionModelDefault.trim() ||
      deps.sessionModelChoices[0]?.trim() ||
      undefined;
    const effectiveSandbox =
      deps.activeThread.sandbox || deps.runSandbox || "workspace-write";
    const effectiveWorkdir = deps.activeWorkspacePath || undefined;

    const runtimeName = deps.activeRuntimeName || deps.selectedRuntime;
    if (runtimeName !== "codex") {
      throw new Error("Session mode only supports codex runtime.");
    }

    deps.addTimelineEntry(
      {
        kind: "user",
        title: "You",
        body: prompt,
      },
      deps.activeThread.id,
    );
    let targetThreadID = deps.activeThread.id;
    deps.forceStickToBottom();
    deps.updateThreadDraft(deps.activeThread.id, "");

    deps.setSubmittingThreadID(deps.activeThread.id);
    try {
      const targetHostID = targetHostIDs[0]?.trim() ?? "";
      if (!targetHostID) {
        throw new Error("host_id is required for codex v2 session");
      }

      let sessionID = deps.activeThread.id.trim();
      if (deps.isLocalDraftSessionID(sessionID)) {
        const sessionResp = await startCodexV2Session(deps.token, {
          host_id: targetHostID,
          path: effectiveWorkdir,
          title: deps.activeThread.title,
          model: effectiveModel,
          approval_policy: deps.activeThread.approvalPolicy || undefined,
          sandbox: effectiveSandbox,
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

      const turnResp = await startCodexV2Turn(deps.token, sessionID, {
        host_id: targetHostID,
        input: turnInput,
        mode: deps.activeThread.codexMode,
        resume_last: deps.activeThread.resumeLast,
        resume_session_id: deps.activeThread.resumeSessionID.trim() || undefined,
        review_uncommitted: deps.activeThread.reviewUncommitted,
        review_base: deps.activeThread.reviewBase.trim() || undefined,
        review_commit: deps.activeThread.reviewCommit.trim() || undefined,
        review_title: deps.activeThread.reviewTitle.trim() || undefined,
        model: effectiveModel,
        cwd: effectiveWorkdir,
        approval_policy: deps.activeThread.approvalPolicy || undefined,
        sandbox: effectiveSandbox,
        search: deps.activeThread.webSearch,
        profile: deps.activeThread.profile.trim() || undefined,
        config: normalizeStringList(deps.activeThread.configFlags),
        enable: normalizeStringList(deps.activeThread.enableFlags),
        disable: normalizeStringList(deps.activeThread.disableFlags),
        add_dirs: normalizeStringList(deps.activeThread.addDirs),
        skip_git_repo_check: deps.activeThread.skipGitRepoCheck,
        ephemeral: deps.activeThread.ephemeral,
        json_output: deps.activeThread.jsonOutput,
      });
      const turnID = extractTurnIDFromPayload(turnResp);
      const runID = turnID || `run_${Date.now()}`;
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
      return;
    } catch (error) {
      deps.finalizeAssistantStreamEntry(targetThreadID, "error");
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Response Failed",
          body: String(error),
        },
        targetThreadID,
      );
      deps.setThreadJobState(targetThreadID, "", "failed");
      deps.setSubmittingThreadID("");
    }
  };

  return {
    submitPromptForActiveThread,
  };
}
