import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listCodexV2PendingRequests,
  resolveCodexV2PendingRequest,
  type CodexV2PendingRequest,
} from "../../api";

type UseCodexPendingRequestsOptions = {
  authReady: boolean;
  token: string;
  sessionID: string;
  watchFast?: boolean;
};

type ResolveRequestPayload = {
  decision?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function useCodexPendingRequests({
  authReady,
  token,
  sessionID,
  watchFast = false,
}: UseCodexPendingRequestsOptions) {
  const [pendingBySessionID, setPendingBySessionID] = useState<
    Record<string, CodexV2PendingRequest[]>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resolvingRequestID, setResolvingRequestID] = useState("");
  const requestSeqRef = useRef(0);

  const activeRequests = useMemo(
    () => pendingBySessionID[sessionID] ?? [],
    [pendingBySessionID, sessionID],
  );

  const refresh = useCallback(async () => {
    const activeToken = token.trim();
    const activeSessionID = sessionID.trim();
    if (!authReady || !activeToken || !activeSessionID) {
      setError("");
      setLoading(false);
      if (!activeSessionID) {
        setPendingBySessionID({});
      }
      return;
    }

    requestSeqRef.current += 1;
    const requestSeq = requestSeqRef.current;
    setLoading(true);
    try {
      const requests = await listCodexV2PendingRequests(activeToken, activeSessionID);
      if (requestSeqRef.current !== requestSeq) return;
      setPendingBySessionID((prev) => ({
        ...prev,
        [activeSessionID]: requests,
      }));
      setError("");
    } catch (err) {
      if (requestSeqRef.current !== requestSeq) return;
      setError(err instanceof Error ? err.message : "Failed to load pending requests.");
    } finally {
      if (requestSeqRef.current === requestSeq) {
        setLoading(false);
      }
    }
  }, [authReady, token, sessionID]);

  const resolve = useCallback(
    async (requestID: string, payload: ResolveRequestPayload) => {
      const activeToken = token.trim();
      const activeSessionID = sessionID.trim();
      const activeRequestID = requestID.trim();
      if (!authReady || !activeToken || !activeSessionID || !activeRequestID) {
        return;
      }
      setResolvingRequestID(activeRequestID);
      setError("");
      try {
        await resolveCodexV2PendingRequest(
          activeToken,
          activeSessionID,
          activeRequestID,
          payload,
        );
        setPendingBySessionID((prev) => ({
          ...prev,
          [activeSessionID]: (prev[activeSessionID] ?? []).filter(
            (item) => item.request_id !== activeRequestID,
          ),
        }));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to resolve pending request.",
        );
        throw err;
      } finally {
        setResolvingRequestID("");
      }
    },
    [authReady, token, sessionID],
  );

  useEffect(() => {
    if (!authReady || !token.trim() || !sessionID.trim()) {
      setLoading(false);
      setError("");
      return;
    }
    void refresh();
    const pollIntervalMS = watchFast ? 1500 : 3500;
    const timer = window.setInterval(() => {
      void refresh();
    }, pollIntervalMS);
    return () => {
      window.clearInterval(timer);
    };
  }, [authReady, token, sessionID, watchFast, refresh]);

  return {
    activeRequests,
    loading,
    error,
    resolvingRequestID,
    refreshPendingRequests: refresh,
    resolvePendingRequest: resolve,
  };
}
