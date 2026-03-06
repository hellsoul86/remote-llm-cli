import { useCallback, useEffect, useState } from "react";

export type AppMode = "session" | "ops";

function modeFromHash(hash: string): AppMode {
  return hash === "#/ops" ? "ops" : "session";
}

function modeToHash(mode: AppMode): string {
  return mode === "ops" ? "#/ops" : "#/session";
}

export function useAppMode() {
  const [appMode, setAppMode] = useState<AppMode>(() =>
    typeof window === "undefined" ? "session" : modeFromHash(window.location.hash),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncFromHash = () => {
      setAppMode(modeFromHash(window.location.hash));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
    };
  }, []);

  const switchMode = useCallback((nextMode: AppMode) => {
    setAppMode(nextMode);
    if (typeof window === "undefined") return;
    const nextHash = modeToHash(nextMode);
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  }, []);

  return {
    appMode,
    switchMode,
  };
}
