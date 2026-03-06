type AppChromeProps = {
  appMode: "session" | "ops";
  onSwitchMode: (mode: "session" | "ops") => void;
  isRefreshing: boolean;
  healthIsError: boolean;
  health: string;
  syncLabel: string;
  onRefreshWorkspace: () => Promise<void>;
  onLogout: () => void;
};

export function AppChrome({
  appMode,
  onSwitchMode,
  isRefreshing,
  healthIsError,
  health,
  syncLabel,
  onRefreshWorkspace,
  onLogout,
}: AppChromeProps) {
  return (
    <>
      <header className="app-topbar">
        <div className="topbar-title">
          <p className="topbar-eyebrow">remote-llm workspace</p>
          <h1>Codex Control App</h1>
        </div>
        <div className="topbar-controls">
          <div className="mode-switch">
            <button
              type="button"
              className={appMode === "session" ? "mode-btn active" : "mode-btn"}
              onClick={() => onSwitchMode("session")}
            >
              Session
            </button>
            <button
              type="button"
              className={appMode === "ops" ? "mode-btn active" : "mode-btn"}
              onClick={() => onSwitchMode("ops")}
            >
              Ops
            </button>
          </div>
          <span
            className={`sync-pill ${isRefreshing ? "busy" : healthIsError ? "error" : "ok"}`}
          >
            {syncLabel}
          </span>
          <button
            onClick={() => void onRefreshWorkspace()}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Syncing..." : "Sync"}
          </button>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      {healthIsError ? (
        <section className="workspace-alert">
          Controller state degraded: {health}
        </section>
      ) : null}
    </>
  );
}
