type SessionHeaderProps = {
  title: string;
  context: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
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
  title,
  context,
  streamTone,
  streamCopy,
  streamLastError,
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
      ? "Connected"
      : streamCopy === "connecting"
        ? "Connecting"
        : streamCopy.startsWith("reconnecting")
          ? streamCopy.replace("reconnecting", "Reconnecting")
          : streamCopy.startsWith("stream error")
            ? streamCopy.replace("stream error", "Needs attention")
            : streamCopy === "offline"
              ? "Offline"
              : streamCopy;

  return (
    <header className="chat-head">
      <div className="chat-head-main">
        <h1>{title || "Session"}</h1>
        <p className="chat-context">{context}</p>
      </div>
      <div className="chat-head-side">
        <div className="chat-head-status">
          <span
            className={`stream-pill ${streamTone}`}
            data-testid="stream-status"
            title={streamLastError || statusCopy}
          >
            {statusCopy}
          </span>
        </div>
        <div className="chat-head-actions">
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
