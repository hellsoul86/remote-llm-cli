import { useCallback, useState } from "react";
import type {
  SessionStreamHealth,
  SessionStreamHealthState,
} from "./stream-types";

export function useSessionStreamHealth() {
  const [sessionStreamHealthByID, setSessionStreamHealthByID] = useState<
    Record<string, SessionStreamHealth>
  >({});

  const updateSessionStreamHealth = useCallback(
    (
      sessionID: string,
      state: SessionStreamHealthState,
      options?: {
        retries?: number;
        lastEventAt?: number;
        lastError?: string;
        throttleMS?: number;
      },
    ) => {
      const id = sessionID.trim();
      if (!id) return;
      setSessionStreamHealthByID((prev) => {
        const current = prev[id] ?? {
          state: "offline",
          retries: 0,
          lastEventAt: 0,
          updatedAt: 0,
          lastError: "",
        };
        const retries = options?.retries ?? current.retries;
        const lastEventAt = options?.lastEventAt ?? current.lastEventAt;
        const lastError = options?.lastError ?? current.lastError;
        const now = Date.now();
        const throttleMS = options?.throttleMS ?? 1100;
        const stateChanged =
          current.state !== state ||
          current.retries !== retries ||
          current.lastError !== lastError;
        const eventAtChanged = current.lastEventAt !== lastEventAt;
        if (
          !stateChanged &&
          (!eventAtChanged || now - current.updatedAt < throttleMS)
        ) {
          return prev;
        }
        const next: SessionStreamHealth = {
          state,
          retries,
          lastEventAt,
          updatedAt: now,
          lastError,
        };
        return {
          ...prev,
          [id]: next,
        };
      });
    },
    [],
  );

  const clearSessionStreamHealth = useCallback((sessionID: string) => {
    const id = sessionID.trim();
    if (!id) return;
    setSessionStreamHealthByID((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const clearAllSessionStreamHealth = useCallback(() => {
    setSessionStreamHealthByID({});
  }, []);

  return {
    sessionStreamHealthByID,
    updateSessionStreamHealth,
    clearSessionStreamHealth,
    clearAllSessionStreamHealth,
  };
}
