type SessionHeaderProps = {
  projectTitle: string;
  projectPath: string;
  hostLabel: string;
  title: string;
  modeLabel: string;
  modelLabel: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
  terminalOpen: boolean;
  canToggleTerminal: boolean;
  onToggleTerminalDrawer: () => void;
  reviewOpen: boolean;
  canToggleReview: boolean;
  onToggleReviewPane: () => void;
  canArchive: boolean;
  archiving: boolean;
  onArchive: () => void;
  canReconnect: boolean;
  onReconnect: () => void;
};

export function SessionHeader({
  projectTitle,
  projectPath,
  hostLabel,
  title,
  modeLabel,
  modelLabel,
  streamTone,
  streamCopy,
  streamLastError,
  terminalOpen,
  canToggleTerminal,
  onToggleTerminalDrawer,
  reviewOpen,
  canToggleReview,
  onToggleReviewPane,
  canArchive,
  archiving,
  onArchive,
  canReconnect,
  onReconnect,
}: SessionHeaderProps) {
  const statusCopy =
    streamCopy === "live"
      ? "Live"
      : streamCopy === "connecting"
        ? "Syncing"
        : streamCopy.startsWith("reconnecting")
          ? streamCopy.replace("reconnecting", "Reconnecting")
          : streamCopy.startsWith("stream error")
            ? streamCopy.replace("stream error", "Needs attention")
            : streamCopy === "offline"
              ? "Waiting"
              : streamCopy;
  const statusDetail =
    streamTone === "ok" || !streamLastError.trim() ? "" : streamLastError.trim();
  const showStatus = statusCopy !== "Live" || Boolean(statusDetail);
  const showHostLabel = hostLabel.trim() !== "";

  return (
    <header className="chat-head">
      <div className="chat-head-main">
        <div className="chat-head-project-row">
          <span className="chat-head-kicker">Project</span>
          <strong className="chat-head-project-title">
            {projectTitle.trim() || "Untitled Project"}
          </strong>
          {showHostLabel ? <span className="chat-head-host-chip">{hostLabel}</span> : null}
        </div>
        <div className="chat-head-thread-row">
          <div className="chat-head-thread-copy">
            <h1>{title || "New Thread"}</h1>
            <p className="chat-context">{projectPath}</p>
          </div>
          <div className="chat-head-meta">
            {modeLabel.trim() ? <span className="chat-meta-chip">{modeLabel}</span> : null}
            {modelLabel.trim() ? <span className="chat-meta-chip">{modelLabel}</span> : null}
          </div>
        </div>
      </div>
      <div className="chat-head-side">
        {showStatus ? (
          <div
            className={`chat-head-status ${streamTone}`}
            data-testid="stream-status"
            title={statusDetail || statusCopy}
          >
            <span className="chat-status-dot" aria-hidden="true" />
            <span className="chat-status-copy">{statusCopy}</span>
            {statusDetail ? <span className="chat-status-detail">{statusDetail}</span> : null}
          </div>
        ) : null}
        <div className="chat-head-actions">
          <button
            type="button"
            className={`ghost stream-reconnect-btn terminal-drawer-toggle${
              terminalOpen ? " active" : ""
            }`}
            data-testid="terminal-drawer-toggle"
            disabled={!canToggleTerminal}
            onClick={onToggleTerminalDrawer}
          >
            Terminal
          </button>
          <button
            type="button"
            className={`ghost stream-reconnect-btn review-pane-toggle${
              reviewOpen ? " active" : ""
            }`}
            data-testid="review-pane-toggle"
            disabled={!canToggleReview}
            onClick={onToggleReviewPane}
          >
            Review
          </button>
          <button
            type="button"
            className="ghost danger-ghost stream-reconnect-btn"
            disabled={!canArchive}
            onClick={onArchive}
          >
            {archiving ? "Archiving..." : "Archive"}
          </button>
          {canReconnect ? (
            <button
              type="button"
              className="ghost stream-reconnect-btn"
              onClick={onReconnect}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
