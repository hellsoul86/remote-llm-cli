import { useCallback, useEffect, useRef, useState } from "react";

import {
  openProjectTerminalSocket,
  type ProjectTerminalFrameRecord,
  type ProjectTerminalSnapshot,
  type ProjectTerminalSocket,
} from "../../api";

type ProjectTerminalStatus =
  | "idle"
  | "connecting"
  | "live"
  | "closed"
  | "error";

type UseProjectTerminalSessionOptions = {
  enabled: boolean;
  token: string;
  projectID: string;
};

export function useProjectTerminalSession({
  enabled,
  token,
  projectID,
}: UseProjectTerminalSessionOptions) {
  const [status, setStatus] = useState<ProjectTerminalStatus>("idle");
  const [terminal, setTerminal] = useState<ProjectTerminalSnapshot | null>(
    null,
  );
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [connectionNonce, setConnectionNonce] = useState(0);
  const socketRef = useRef<ProjectTerminalSocket | null>(null);
  const cursorRef = useRef(0);
  const projectRef = useRef("");

  useEffect(() => {
    const nextProjectID = projectID.trim();
    if (projectRef.current === nextProjectID) {
      return;
    }
    projectRef.current = nextProjectID;
    cursorRef.current = 0;
    setTerminal(null);
    setOutput("");
    setError("");
    setStatus(nextProjectID ? "idle" : "idle");
  }, [projectID]);

  useEffect(() => {
    const trimmedToken = token.trim();
    const trimmedProjectID = projectID.trim();
    if (!enabled || !trimmedToken || !trimmedProjectID) {
      socketRef.current?.close();
      socketRef.current = null;
      if (!trimmedProjectID) {
        setTerminal(null);
        setOutput("");
        setError("");
        setStatus("idle");
      }
      return;
    }

    const controller = new AbortController();
    setError("");
    setStatus((current) =>
      current === "closed" ? "connecting" : "connecting",
    );

    try {
      const socket = openProjectTerminalSocket(trimmedToken, trimmedProjectID, {
        after: cursorRef.current,
        signal: controller.signal,
        onReady(nextTerminal) {
          cursorRef.current = Math.max(
            cursorRef.current,
            nextTerminal.cursor ?? 0,
          );
          setTerminal(nextTerminal);
          setStatus(nextTerminal.state === "exited" ? "closed" : "live");
        },
        onFrame(frame: ProjectTerminalFrameRecord) {
          cursorRef.current = Math.max(cursorRef.current, frame.seq ?? 0);
          if (frame.type === "output") {
            setOutput((current) => `${current}${frame.data ?? ""}`);
            setStatus("live");
            setTerminal((current) =>
              current
                ? {
                    ...current,
                    cursor: Math.max(current.cursor ?? 0, frame.seq ?? 0),
                    updated_at: frame.timestamp,
                  }
                : current,
            );
            return;
          }
          if (frame.type === "exit") {
            setTerminal((current) =>
              current
                ? {
                    ...current,
                    state: "exited",
                    cursor: Math.max(current.cursor ?? 0, frame.seq ?? 0),
                    updated_at: frame.timestamp,
                    closed_at: frame.timestamp,
                    exit_code: frame.exit_code,
                  }
                : current,
            );
            setStatus("closed");
          }
        },
        onError(nextError) {
          setError(nextError.message);
          setStatus("error");
        },
        onClose() {
          setStatus((current) =>
            current === "error"
              ? current
              : current === "closed"
                ? current
                : "closed",
          );
        },
      });
      socketRef.current = socket;
      return () => {
        controller.abort();
        if (socketRef.current === socket) {
          socketRef.current.close();
          socketRef.current = null;
        }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("error");
      return () => {
        controller.abort();
      };
    }
  }, [connectionNonce, enabled, token, projectID]);

  const sendInput = useCallback((data: string) => {
    socketRef.current?.sendInput(data);
  }, []);

  const sendLine = useCallback((line: string) => {
    const nextLine = line.replace(/\r?\n$/, "");
    if (!nextLine.trim()) return;
    socketRef.current?.sendInput(`${nextLine}\n`);
  }, []);

  const interrupt = useCallback(() => {
    socketRef.current?.interrupt();
  }, []);

  const clear = useCallback(() => {
    setOutput("");
    setError("");
    setTerminal((current) =>
      current
        ? {
            ...current,
            cursor: Math.max(current.cursor ?? 0, cursorRef.current),
          }
        : current,
    );
  }, []);

  const reconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnectionNonce((current) => current + 1);
  }, []);

  return {
    status,
    terminal,
    output,
    error,
    sendInput,
    sendLine,
    interrupt,
    clear,
    reconnect,
    hasLiveTransport:
      Boolean(terminal) ||
      status === "connecting" ||
      status === "live" ||
      status === "closed",
  };
}
