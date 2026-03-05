type SessionHeaderProps = {
  title: string;
  context: string;
  streamTone: string;
  streamCopy: string;
  streamLastError: string;
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
  canArchive,
  archiving,
  onArchive,
  canReconnect,
  onReconnect,
}: SessionHeaderProps) {
  return (
    <header className="chat-head">
      <div>
        <h1>{title || "Session"}</h1>
        <p className="chat-context">{context}</p>
      </div>
      <div className="chat-head-side">
        <span
          className={`stream-pill ${streamTone}`}
          data-testid="stream-status"
          title={streamLastError || `stream ${streamCopy}`}
        >
          stream {streamCopy}
        </span>
        <button
          type="button"
          className="ghost danger-ghost stream-reconnect-btn"
          disabled={!canArchive}
          onClick={onArchive}
        >
          {archiving ? "Archiving..." : "Archive"}
        </button>
        <button
          type="button"
          className="ghost stream-reconnect-btn"
          disabled={!canReconnect}
          onClick={onReconnect}
        >
          Reconnect
        </button>
      </div>
    </header>
  );
}
