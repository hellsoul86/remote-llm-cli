import type { MutableRefObject } from "react";
import type { SessionEventRecord, SessionStreamFrame } from "../../api";
import type { SessionEventHandleOptions } from "./session-run-events";
import { decodeSessionEventRecord } from "./session-events";
import { runSessionStreamLoop } from "./stream-loop";
import type {
  SessionRunStreamState,
  SessionStreamHealthState,
} from "./stream-types";

export type SessionStreamRuntimeState = {
  controller: AbortController;
  ready: boolean;
  lastEventAt: number;
  suppressReplaySurface: boolean;
};

type CreateSessionStreamControllerDeps = {
  sessionStreamStateRef: MutableRefObject<
    Map<string, SessionStreamRuntimeState>
  >;
  sessionEventQueueRef: MutableRefObject<Map<string, Promise<void>>>;
  sessionRunStateRef: MutableRefObject<Map<string, SessionRunStreamState>>;
  runningSessionIDsRef: MutableRefObject<Set<string>>;
  sessionEventCursorRef: MutableRefObject<Map<string, number>>;
  setSessionEventCursor: (sessionID: string, cursor: number) => void;
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
  clearSessionStreamHealth: (sessionID: string) => void;
  clearAllSessionStreamHealth: () => void;
  handleSessionEventRecord: (
    sessionID: string,
    event: SessionEventRecord,
    options?: SessionEventHandleOptions,
  ) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

export function createSessionStreamController(
  deps: CreateSessionStreamControllerDeps,
) {
  const stopSessionStream = (
    sessionID: string,
    options?: { preserveRunState?: boolean; preserveHealth?: boolean },
  ) => {
    const state = deps.sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    state.controller.abort();
    deps.sessionStreamStateRef.current.delete(sessionID);
    deps.sessionEventQueueRef.current.delete(sessionID);
    if (!options?.preserveRunState) {
      deps.sessionRunStateRef.current.delete(sessionID);
    }
    if (!options?.preserveHealth) {
      deps.clearSessionStreamHealth(sessionID);
    }
  };

  const stopAllSessionStreams = () => {
    for (const state of deps.sessionStreamStateRef.current.values()) {
      state.controller.abort();
    }
    deps.sessionStreamStateRef.current.clear();
    deps.sessionEventQueueRef.current.clear();
    deps.sessionRunStateRef.current.clear();
    deps.clearAllSessionStreamHealth();
  };

  const handleSessionStreamFrame = (
    sessionID: string,
    frame: SessionStreamFrame,
  ) => {
    const state = deps.sessionStreamStateRef.current.get(sessionID);
    if (!state) return;
    const receivedAt = Date.now();
    state.lastEventAt = receivedAt;

    if (frame.event === "session.ready") {
      state.ready = true;
      state.suppressReplaySurface = false;
      deps.updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
        lastError: "",
      });
      const data = asRecord(frame.data);
      const cursor = data ? Number(data.cursor) : NaN;
      if (Number.isFinite(cursor)) {
        deps.setSessionEventCursor(sessionID, cursor);
      }
      return;
    }

    if (frame.event === "session.reset") {
      state.ready = false;
      deps.updateSessionStreamHealth(sessionID, "reconnecting", {
        lastEventAt: receivedAt,
        throttleMS: 0,
      });
      const data = asRecord(frame.data);
      const nextAfter = data ? Number(data.next_after) : NaN;
      state.suppressReplaySurface =
        !(Number.isFinite(nextAfter) && nextAfter > 0);
      if (Number.isFinite(nextAfter)) {
        deps.setSessionEventCursor(sessionID, nextAfter);
      }
      return;
    }

    if (frame.event === "heartbeat") {
      deps.updateSessionStreamHealth(sessionID, "live", {
        lastEventAt: receivedAt,
      });
      return;
    }

    if (frame.event !== "session.event") {
      return;
    }

    deps.updateSessionStreamHealth(sessionID, "live", {
      lastEventAt: receivedAt,
      lastError: "",
    });
    const event = decodeSessionEventRecord(frame.data);
    if (!event) return;

    const current = deps.sessionEventCursorRef.current.get(sessionID) ?? 0;
    if (event.seq <= current) return;
    deps.setSessionEventCursor(sessionID, event.seq);
    const surfaceByReplay = !state.suppressReplaySurface;
    const surfaceCompletions = state.ready || surfaceByReplay;
    const surfaceLifecycle = state.ready || surfaceByReplay;
    const previousQueue =
      deps.sessionEventQueueRef.current.get(sessionID) ?? Promise.resolve();
    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(() =>
        deps.handleSessionEventRecord(sessionID, event, {
          surfaceCompletions,
          surfaceLifecycle,
        }),
      )
      .catch(() => undefined);
    deps.sessionEventQueueRef.current.set(sessionID, nextQueue);
    void nextQueue.finally(() => {
      const currentQueue = deps.sessionEventQueueRef.current.get(sessionID);
      if (currentQueue !== nextQueue) return;
      deps.sessionEventQueueRef.current.delete(sessionID);
    });
  };

  const startSessionStream = (sessionID: string, authToken: string) => {
    const trimmedSessionID = sessionID.trim();
    if (!trimmedSessionID) return;
    if (deps.sessionStreamStateRef.current.has(trimmedSessionID)) return;

    const controller = new AbortController();
    deps.sessionStreamStateRef.current.set(trimmedSessionID, {
      controller,
      ready: false,
      lastEventAt: 0,
      suppressReplaySurface: true,
    });
    deps.updateSessionStreamHealth(trimmedSessionID, "connecting", {
      retries: 0,
      lastEventAt: 0,
      lastError: "",
      throttleMS: 0,
    });
    void runSessionStreamLoop({
      authToken,
      sessionID: trimmedSessionID,
      controller,
      getAfter: () => deps.sessionEventCursorRef.current.get(trimmedSessionID) ?? 0,
      setSuppressReplaySurface: (value) => {
        const streamState =
          deps.sessionStreamStateRef.current.get(trimmedSessionID);
        if (streamState && streamState.controller === controller) {
          streamState.suppressReplaySurface = value;
        }
      },
      onFrame: (frame) => handleSessionStreamFrame(trimmedSessionID, frame),
      isRunningSession: () =>
        deps.runningSessionIDsRef.current.has(trimmedSessionID),
      onState: (state, options) => {
        const active = deps.sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        deps.updateSessionStreamHealth(trimmedSessionID, state, {
          retries: options?.retries,
          lastError: options?.lastError,
          throttleMS: 0,
        });
      },
      onBeforeBackoff: () => {
        const active = deps.sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        active.ready = false;
      },
      onFinalize: () => {
        const active = deps.sessionStreamStateRef.current.get(trimmedSessionID);
        if (!active || active.controller !== controller) return;
        deps.sessionStreamStateRef.current.delete(trimmedSessionID);
        deps.sessionEventQueueRef.current.delete(trimmedSessionID);
      },
    });
  };

  return {
    stopSessionStream,
    stopAllSessionStreams,
    startSessionStream,
  };
}
