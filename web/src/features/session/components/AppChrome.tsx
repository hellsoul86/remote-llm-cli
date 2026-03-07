type AppChromeProps = {
  appMode: "session" | "ops";
  isRefreshing: boolean;
  healthIsError: boolean;
  health: string;
  onRefreshWorkspace: () => Promise<void>;
  onOpenUtilities: () => void;
  onReturnToSession: () => void;
  onLogout: () => void;
};

export function AppChrome({
  appMode,
  isRefreshing,
  healthIsError,
  health,
  onRefreshWorkspace,
  onOpenUtilities,
  onReturnToSession,
  onLogout,
}: AppChromeProps) {
  const statusCopy = healthIsError
    ? "Controller paused"
    : appMode === "ops" && isRefreshing
      ? "Refreshing"
      : "";

  return (
    <header className={`app-topbar ${appMode === "ops" ? "app-topbar-utility" : ""}`}>
      <div className="topbar-title">
        <h1>Codex</h1>
        {appMode === "ops" ? <span className="topbar-surface-tag">Tools</span> : null}
      </div>
      <div className="topbar-controls">
        {statusCopy ? (
          <span
            className={`sync-pill ${healthIsError ? "error" : "busy"}`}
            role="status"
            title={health}
          >
            {statusCopy}
          </span>
        ) : null}
        {appMode === "ops" ? (
          <>
            <button
              type="button"
              className="ghost topbar-utility-btn"
              onClick={onReturnToSession}
            >
              Return to workbench
            </button>
            <button
              type="button"
              className="ghost topbar-quiet-btn"
              onClick={() => void onRefreshWorkspace()}
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
            <button type="button" className="ghost topbar-quiet-btn" onClick={onLogout}>
              Lock
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ghost topbar-utility-btn"
            onClick={onOpenUtilities}
          >
            Tools
          </button>
        )}
      </div>
    </header>
  );
}
