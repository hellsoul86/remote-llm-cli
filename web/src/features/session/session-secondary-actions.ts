import type { Dispatch, FormEvent, MutableRefObject, SetStateAction } from "react";
import {
  cancelRunJob,
  forkCodexV2Session,
  interruptCodexV2Turn,
  type Host,
} from "../../api";
import type { ConversationThread, TimelineEntry } from "../../domains/session";
import { extractThreadIDFromCodexSessionResponse } from "./codex-parsing";
import { lastUserPromptFromTimeline } from "./runtime-utils";

type CreateSessionSecondaryActionsDeps = {
  authPhase: "checking" | "locked" | "ready";
  token: string;
  activeThread: ConversationThread | null;
  activeWorkspaceHostID: string;
  activeWorkspacePath: string;
  activeRuntimeName: string;
  selectedRuntime: string;
  hosts: Host[];
  cancelingThreadID: string;
  promptInputRef: MutableRefObject<HTMLTextAreaElement | null>;

  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    threadID?: string,
  ) => void;
  submitPromptForActiveThread: (trimmedPrompt: string) => Promise<void>;
  refreshProjectsFromSource: (
    authToken: string,
    sourceHosts: Host[],
    discoverEnabled: boolean,
    preserveOnError?: boolean,
  ) => Promise<void>;
  activateThread: (threadID: string) => void;
  forkThread: (threadID: string) => void;
  isLocalDraftSessionID: (sessionID: string) => boolean;

  setCancelingThreadID: Dispatch<SetStateAction<string>>;
};

export function createSessionSecondaryActions(
  deps: CreateSessionSecondaryActionsDeps,
) {
  const canRun = () => deps.authPhase === "ready" && deps.token.trim() !== "";

  const onSendPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun() || !deps.activeThread) return;
    const editorValue = deps.promptInputRef.current?.value ?? "";
    const trimmedPrompt = deps.activeThread.draft.trim() || editorValue.trim();
    await deps.submitPromptForActiveThread(trimmedPrompt);
  };

  const onStopActiveSessionRun = async () => {
    if (!canRun() || !deps.activeThread) return;
    const runID = deps.activeThread.activeJobID.trim();
    if (!runID) return;
    if (deps.cancelingThreadID === deps.activeThread.id) return;
    deps.setCancelingThreadID(deps.activeThread.id);
    try {
      if (deps.activeRuntimeName === "codex") {
        await interruptCodexV2Turn(deps.token, deps.activeThread.id, runID, {
          host_id: deps.activeWorkspaceHostID || undefined,
        });
      } else {
        await cancelRunJob(deps.token, runID);
      }
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "running",
          title: "Stopping",
          body: "Stopping current response...",
        },
        deps.activeThread.id,
      );
    } catch (error) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Stop Failed",
          body: String(error),
        },
        deps.activeThread.id,
      );
    } finally {
      deps.setCancelingThreadID("");
    }
  };

  const onRegenerateActiveSession = async () => {
    if (!canRun() || !deps.activeThread) return;
    const prompt = lastUserPromptFromTimeline(deps.activeThread.timeline);
    if (!prompt) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Regenerate Unavailable",
          body: "No previous user prompt in this session.",
        },
        deps.activeThread.id,
      );
      return;
    }
    await deps.submitPromptForActiveThread(prompt);
  };

  const onForkActiveSession = async () => {
    if (!deps.activeThread) return;
    if (!canRun()) {
      deps.forkThread(deps.activeThread.id);
      return;
    }
    if (
      deps.activeRuntimeName !== "codex" ||
      deps.isLocalDraftSessionID(deps.activeThread.id)
    ) {
      deps.forkThread(deps.activeThread.id);
      return;
    }
    try {
      const response = await forkCodexV2Session(deps.token, deps.activeThread.id, {
        host_id: deps.activeWorkspaceHostID || undefined,
        path: deps.activeWorkspacePath || undefined,
        title: `Fork · ${deps.activeThread.title}`,
      });
      const nextID =
        extractThreadIDFromCodexSessionResponse(response) ||
        response.session.id.trim();
      await deps.refreshProjectsFromSource(deps.token, deps.hosts, true, true);
      if (nextID) {
        deps.activateThread(nextID);
      }
    } catch (error) {
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Fork Failed",
          body: String(error),
        },
        deps.activeThread.id,
      );
    }
  };

  const onEditAndResend = async (entry: TimelineEntry) => {
    if (!canRun() || !deps.activeThread) return;
    if (entry.kind !== "user") return;
    const edited = window.prompt("Edit prompt before resend", entry.body);
    if (edited === null) return;
    const trimmed = edited.trim();
    if (!trimmed) {
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
    await deps.submitPromptForActiveThread(trimmed);
  };

  return {
    onSendPrompt,
    onStopActiveSessionRun,
    onRegenerateActiveSession,
    onForkActiveSession,
    onEditAndResend,
  };
}
