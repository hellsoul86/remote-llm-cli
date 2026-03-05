import type { MutableRefObject } from "react";
import type { SessionEventRecord } from "../../api";
import type { TimelineEntry, WorkspaceDirectory } from "../../domains/session";
import { EMPTY_ASSISTANT_FALLBACK } from "./config";
import {
  buildCodexRuntimeCardFromEvent,
  parseCodexAssistantTextFromStdout,
  parseCodexEventsIncremental,
  parseCodexSessionTitleFromStdout,
} from "./codex-parsing";
import { normalizeSessionEvent } from "./session-events";
import type { SessionRunStreamState } from "./stream-types";
import type { SessionLastStatus } from "./types";
import {
  sessionCompletionCopy,
  sessionEventHostLabel,
} from "./runtime-utils";
import { clipStreamText } from "./utils";

export type SessionEventHandleOptions = {
  surfaceCompletions?: boolean;
  surfaceLifecycle?: boolean;
};

type CreateSessionRunEventHandlersDeps = {
  workspaces: WorkspaceDirectory[];
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;
  activeThreadIDRef: MutableRefObject<string>;
  threadTitleMapRef: MutableRefObject<Map<string, string>>;
  setThreadJobState: (
    sessionID: string,
    runID: string,
    status?: SessionLastStatus,
  ) => void;
  setThreadUnread: (sessionID: string, unread: boolean) => void;
  setThreadTitle: (sessionID: string, title: string) => void;
  setActiveJobID: (runID: string) => void;
  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    sessionID: string,
  ) => void;
  upsertAssistantStreamEntry: (sessionID: string, body: string) => void;
  finalizeAssistantStreamEntry: (
    sessionID: string,
    state: "success" | "error",
    body?: string,
  ) => void;
  notifySessionDone: (title: string, body: string) => void;
  pushSessionAlert: (alert: {
    threadID: string;
    title: string;
    body: string;
  }) => void;
  markRunCompleted: (runID: string) => boolean;
  hasCompletedRun: (runID: string) => boolean;
  shouldSurfaceCompletion: (createdAt?: string) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function appendCodexStdoutChunk(state: SessionRunStreamState, chunk: string) {
  if (!chunk) return;
  state.stdout = `${state.stdout}${chunk}`;
  if (state.stdout.length > 220000) {
    const trim = state.stdout.length - 220000;
    state.stdout = state.stdout.slice(trim);
    state.eventParseOffset = Math.max(0, state.eventParseOffset - trim);
  }
}

export function ensureSessionRunState(
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>,
  sessionID: string,
  runID: string,
): SessionRunStreamState {
  const existing = sessionRunStateRef.current.get(sessionID);
  if (existing && existing.runID === runID) return existing;
  const next: SessionRunStreamState = {
    runID,
    stdout: "",
    streamSeen: false,
    assistantFinalized: false,
    failureHints: [],
    eventParseOffset: 0,
    surfacedEventKeys: new Set(),
  };
  sessionRunStateRef.current.set(sessionID, next);
  return next;
}

export function surfaceRuntimeCardsFromRunState(
  addTimelineEntry: (
    entry: Omit<TimelineEntry, "id" | "createdAt">,
    sessionID: string,
  ) => void,
  sessionID: string,
  runID: string,
  state: SessionRunStreamState,
  surface: boolean,
) {
  const parsed = parseCodexEventsIncremental(
    state.stdout,
    state.eventParseOffset,
  );
  state.eventParseOffset = parsed.nextOffset;
  if (parsed.events.length === 0) return;
  for (const event of parsed.events) {
    const card = buildCodexRuntimeCardFromEvent(event, runID);
    if (!card) continue;
    if (state.surfacedEventKeys.has(card.key)) continue;
    state.surfacedEventKeys.add(card.key);
    if (!surface) continue;
    addTimelineEntry(
      {
        kind: "system",
        state: card.state,
        title: card.title,
        body: card.body,
      },
      sessionID,
    );
  }
}

export function createSessionRunEventHandlers(
  deps: CreateSessionRunEventHandlersDeps,
) {
  const sessionActiveRunID = (sessionID: string): string => {
    const normalizedSessionID = sessionID.trim();
    if (!normalizedSessionID) return "";
    for (const workspace of deps.workspaces) {
      for (const thread of workspace.sessions) {
        if (thread.id !== normalizedSessionID) continue;
        return thread.activeJobID.trim();
      }
    }
    return "";
  };

  const markSessionDone = (
    sessionID: string,
    runID: string,
    status: "succeeded" | "failed" | "canceled",
    options?: { surface?: boolean },
  ): boolean => {
    if (!runID || !deps.markRunCompleted(runID)) return false;
    if (!options?.surface) return false;
    const sessionTitle = deps.threadTitleMapRef.current.get(sessionID) ?? "Session";
    const completion = sessionCompletionCopy(status);
    deps.notifySessionDone(
      `${sessionTitle} ${completion.suffix}`,
      completion.body,
    );
    deps.pushSessionAlert({
      threadID: sessionID,
      title: `${sessionTitle} ${completion.suffix}`,
      body: completion.body,
    });
    return true;
  };

  const finalizeStreamCompleted = async (
    sessionID: string,
    runID: string,
    completedAt?: string,
    options?: { surfaceCompletions?: boolean },
  ) => {
    if (runID && deps.hasCompletedRun(runID)) {
      return;
    }
    const state = deps.sessionRunStateRef.current.get(sessionID);
    const assistantText = state
      ? parseCodexAssistantTextFromStdout(state.stdout, false)
      : "";
    const failureSummary = state?.failureHints.join("\n") ?? "";
    const failed = failureSummary.trim() !== "";

    if (failed) {
      if (state?.streamSeen) {
        deps.finalizeAssistantStreamEntry(sessionID, "error");
      }
      deps.addTimelineEntry(
        {
          kind: "system",
          state: "error",
          title: "Failed",
          body: failureSummary || "Session failed.",
        },
        sessionID,
      );
      deps.setThreadJobState(sessionID, "", "failed");
      const surfaced = markSessionDone(sessionID, runID, "failed", {
        surface:
          options?.surfaceCompletions !== false &&
          deps.shouldSurfaceCompletion(completedAt),
      });
      if (surfaced && sessionID !== deps.activeThreadIDRef.current) {
        deps.setThreadUnread(sessionID, true);
      }
      deps.sessionRunStateRef.current.delete(sessionID);
      return;
    }

    deps.setThreadJobState(sessionID, "", "succeeded");
    if (assistantText.trim()) {
      if (state?.streamSeen && !state.assistantFinalized) {
        deps.finalizeAssistantStreamEntry(
          sessionID,
          "success",
          clipStreamText(assistantText),
        );
      } else if (!state?.assistantFinalized) {
        deps.addTimelineEntry(
          {
            kind: "assistant",
            state: "success",
            title: "Assistant",
            body: assistantText,
          },
          sessionID,
        );
      }
    } else if (state?.streamSeen && !state?.assistantFinalized) {
      deps.finalizeAssistantStreamEntry(
        sessionID,
        "success",
        EMPTY_ASSISTANT_FALLBACK,
      );
    }
    const surfaced = markSessionDone(sessionID, runID, "succeeded", {
      surface:
        options?.surfaceCompletions !== false &&
        deps.shouldSurfaceCompletion(completedAt),
    });
    if (surfaced && sessionID !== deps.activeThreadIDRef.current) {
      deps.setThreadUnread(sessionID, true);
    }
    deps.sessionRunStateRef.current.delete(sessionID);
  };

  const handleSessionEventRecord = async (
    sessionID: string,
    event: SessionEventRecord,
    options?: SessionEventHandleOptions,
  ) => {
    const normalized = normalizeSessionEvent(event);
    if (!normalized) return;
    let { eventType, payload, runID } = normalized;
    if (!runID) {
      runID = sessionActiveRunID(sessionID);
    }
    const surfaceLifecycle = options?.surfaceLifecycle !== false;

    switch (eventType) {
      case "session.title.updated": {
        const title =
          typeof payload.title === "string" ? payload.title.trim() : "";
        if (title) {
          deps.setThreadTitle(sessionID, title);
        }
        return;
      }
      case "run.started": {
        const id = runID || `run_${Date.now()}`;
        ensureSessionRunState(deps.sessionRunStateRef, sessionID, id);
        deps.setThreadJobState(sessionID, id, "running");
        if (sessionID === deps.activeThreadIDRef.current) {
          deps.setActiveJobID(id);
        }
        return;
      }
      case "target.started": {
        return;
      }
      case "assistant.delta": {
        if (!runID) return;
        const state = ensureSessionRunState(
          deps.sessionRunStateRef,
          sessionID,
          runID,
        );
        const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
        if (!chunk.trim()) return;
        appendCodexStdoutChunk(state, chunk);
        surfaceRuntimeCardsFromRunState(
          deps.addTimelineEntry,
          sessionID,
          runID,
          state,
          surfaceLifecycle,
        );
        const nextTitle = parseCodexSessionTitleFromStdout(state.stdout);
        if (nextTitle) {
          deps.setThreadTitle(sessionID, nextTitle);
        }
        const contentOnly = parseCodexAssistantTextFromStdout(
          state.stdout,
          false,
        );
        if (contentOnly.trim()) {
          state.streamSeen = true;
          deps.upsertAssistantStreamEntry(sessionID, clipStreamText(contentOnly));
        } else if (
          state.stdout.includes('"type":"turn.started"') ||
          state.stdout.includes('"type":"thread.started"')
        ) {
          state.streamSeen = true;
        }
        return;
      }
      case "assistant.completed": {
        if (!runID) return;
        const state = ensureSessionRunState(
          deps.sessionRunStateRef,
          sessionID,
          runID,
        );
        const contentOnly = parseCodexAssistantTextFromStdout(
          state.stdout,
          false,
        );
        if (contentOnly.trim()) {
          state.streamSeen = true;
          deps.finalizeAssistantStreamEntry(
            sessionID,
            "success",
            clipStreamText(contentOnly),
          );
          state.assistantFinalized = true;
          return;
        }
        // Keep stream entry in running state when content is unavailable here.
        // run.completed/job.succeeded handler will perform job-response fallback.
        state.assistantFinalized = false;
        return;
      }
      case "target.done": {
        if (!runID) return;
        const state = ensureSessionRunState(
          deps.sessionRunStateRef,
          sessionID,
          runID,
        );
        const status =
          typeof payload.status === "string" ? payload.status.trim() : "";
        const host = sessionEventHostLabel(payload);
        const exitCode = payload.exit_code;
        const codeText =
          typeof exitCode === "number" ? ` exit=${exitCode}` : "";
        const errorText =
          typeof payload.error === "string" && payload.error.trim()
            ? ` error=${payload.error.trim()}`
            : "";
        if (status && status !== "ok") {
          state.failureHints.push(`${host} failed${codeText}${errorText}`);
        }
        return;
      }
      case "job.cancel_requested": {
        return;
      }
      case "run.failed":
      case "job.failed": {
        const id = runID || `run_${Date.now()}`;
        const state = ensureSessionRunState(
          deps.sessionRunStateRef,
          sessionID,
          id,
        );
        const errorRecord = asRecord(payload.error);
        const errText =
          typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : typeof errorRecord?.message === "string" &&
                errorRecord.message.trim()
              ? errorRecord.message.trim()
              : "Session failed.";
        if (state.streamSeen) {
          deps.finalizeAssistantStreamEntry(sessionID, "error");
        }
        deps.addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Failed",
            body: errText,
          },
          sessionID,
        );
        deps.setThreadJobState(sessionID, "", "failed");
        const surfaced = markSessionDone(sessionID, id, "failed", {
          surface:
            options?.surfaceCompletions !== false &&
            deps.shouldSurfaceCompletion(event.created_at),
        });
        if (surfaced && sessionID !== deps.activeThreadIDRef.current) {
          deps.setThreadUnread(sessionID, true);
        }
        deps.sessionRunStateRef.current.delete(sessionID);
        return;
      }
      case "run.canceled":
      case "job.canceled": {
        const id = runID || `run_${Date.now()}`;
        const state = ensureSessionRunState(
          deps.sessionRunStateRef,
          sessionID,
          id,
        );
        if (state.streamSeen) {
          deps.finalizeAssistantStreamEntry(sessionID, "error");
        }
        deps.addTimelineEntry(
          {
            kind: "system",
            state: "error",
            title: "Interrupted",
            body: "Session interrupted.",
          },
          sessionID,
        );
        deps.setThreadJobState(sessionID, "", "canceled");
        const surfaced = markSessionDone(sessionID, id, "canceled", {
          surface:
            options?.surfaceCompletions !== false &&
            deps.shouldSurfaceCompletion(event.created_at),
        });
        if (surfaced && sessionID !== deps.activeThreadIDRef.current) {
          deps.setThreadUnread(sessionID, true);
        }
        deps.sessionRunStateRef.current.delete(sessionID);
        return;
      }
      case "run.completed":
      case "job.succeeded": {
        if (!runID) return;
        await finalizeStreamCompleted(sessionID, runID, event.created_at, {
          surfaceCompletions: options?.surfaceCompletions !== false,
        });
        return;
      }
      default:
        return;
    }
  };

  return {
    handleSessionEventRecord,
  };
}
