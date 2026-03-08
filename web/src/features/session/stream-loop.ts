import { streamSessionEvents, type SessionStreamFrame } from "../../api";

type StreamLoopState = "reconnecting" | "live" | "error" | "offline";

type RunSessionStreamLoopOptions = {
  authToken: string;
  sessionID: string;
  controller: AbortController;
  getAfter: () => number;
  setSuppressReplaySurface: (value: boolean) => void;
  onOpen?: () => void;
  onFrame: (frame: SessionStreamFrame) => void;
  isRunningSession: () => boolean;
  onState: (
    state: StreamLoopState,
    options?: { retries?: number; lastError?: string },
  ) => void;
  onBeforeBackoff?: () => void;
  onFinalize: () => void;
};

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort);
  });
}

export async function runSessionStreamLoop(
  options: RunSessionStreamLoopOptions,
): Promise<void> {
  const {
    authToken,
    sessionID,
    controller,
    getAfter,
    setSuppressReplaySurface,
    onOpen,
    onFrame,
    isRunningSession,
    onState,
    onBeforeBackoff,
    onFinalize,
  } = options;

  let backoff = 700;
  let retries = 0;
  while (!controller.signal.aborted) {
    if (retries > 0) {
      onState("reconnecting", { retries });
    }
    const after = getAfter();
    setSuppressReplaySurface(after <= 0);
    try {
      await streamSessionEvents(authToken, sessionID, {
        after,
        signal: controller.signal,
        onOpen,
        onFrame,
      });
      if (controller.signal.aborted) break;
      if (isRunningSession()) {
        retries += 1;
        onState("reconnecting", {
          retries,
          lastError: "stream closed, retrying",
        });
      } else {
        retries = 0;
        onState("live", {
          retries: 0,
          lastError: "",
        });
      }
    } catch {
      if (controller.signal.aborted) break;
      retries += 1;
      onState(retries >= 3 ? "error" : "reconnecting", {
        retries,
        lastError: "stream interrupted, retrying",
      });
    }
    if (controller.signal.aborted) break;
    onBeforeBackoff?.();
    await waitWithAbort(backoff, controller.signal);
    backoff = Math.min(6000, Math.round(backoff * 1.7));
  }

  onState("offline");
  onFinalize();
}
