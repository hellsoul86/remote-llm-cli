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
    ? "Connection needs attention"
    : appMode === "ops" && isRefreshing
      ? "Syncing workspace"
      : "";

  return (
    <>
      <header className={`app-topbar ${appMode === "ops" ? "app-topbar-utility" : ""}`}>
        <div className="topbar-title">
          <p className="topbar-context">{appMode === "ops" ? "secondary surfaces" : "workspace"}</p>
          <h1>{appMode === "ops" ? "Utilities" : "Codex"}</h1>
        </div>
        <div className="topbar-controls">
          {statusCopy ? (
            <span
              className={`sync-pill ${isRefreshing ? "busy" : "error"}`}
              role="status"
              title={health}
            >
              {statusCopy}
            </span>
          ) : null}
          {appMode === "ops" ? (
            <button
              type="button"
              className="ghost topbar-utility-btn"
              onClick={onReturnToSession}
            >
              Back to Codex
            </button>
          ) : (
            <button
              type="button"
              className="ghost topbar-utility-btn"
              onClick={onOpenUtilities}
            >
              Utilities
            </button>
          )}
          {appMode === "ops" ? (
            <>
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
          ) : null}
        </div>
      </header>

      {healthIsError ? (
        <section className="workspace-alert" role="status">
          Connection needs attention. Session sync may pause until the controller recovers.
        </section>
      ) : null}
    </>
  );
}
