import { useState } from "react";

import type { TimelineState } from "../../../domains/session";

type TerminalCommandEntry = {
  id: string;
  title: string;
  command: string;
  output: string;
  interactions: string[];
  processId: string;
  timestamp: string;
  state: TimelineState;
};

type SessionTerminalDrawerProps = {
  workdir: string;
  hostLabel: string;
  commands: TerminalCommandEntry[];
  liveStatus: "idle" | "connecting" | "live" | "closed" | "error";
  liveTransportAvailable: boolean;
  liveOutput: string;
  liveError: string;
  onSendLine: (line: string) => void;
  onInterrupt: () => void;
  onReconnect: () => void;
  onClose: () => void;
  onClear: () => void;
};

function liveStatusCopy(
  status: SessionTerminalDrawerProps["liveStatus"],
): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "live":
      return "Connected";
    case "closed":
      return "Exited";
    case "error":
      return "Unavailable";
    default:
      return "Idle";
  }
}

export function SessionTerminalDrawer({
  workdir,
  hostLabel,
  commands,
  liveStatus,
  liveTransportAvailable,
  liveOutput,
  liveError,
  onSendLine,
  onInterrupt,
  onReconnect,
  onClose,
  onClear,
}: SessionTerminalDrawerProps) {
  const context = [workdir.trim(), hostLabel.trim()]
    .filter(Boolean)
    .join(" · ");
  const [draft, setDraft] = useState("");
  const showLiveShell = liveTransportAvailable && liveStatus !== "error";

  return (
    <section className="terminal-drawer" data-testid="terminal-drawer">
      <div className="terminal-drawer-head">
        <div className="terminal-drawer-copy">
          <p className="terminal-drawer-eyebrow">Project terminal</p>
          <h3>Terminal</h3>
          <p className="terminal-drawer-context">
            {context || "Current project"}
          </p>
        </div>
        <div className="terminal-drawer-actions">
          <span
            className={`terminal-drawer-status terminal-status-${liveStatus}`}
            data-testid="terminal-live-status"
          >
            {liveStatusCopy(liveStatus)}
          </span>
          <span className="terminal-drawer-shortcut">Ctrl+L clears</span>
          {showLiveShell ? (
            <button
              type="button"
              className="ghost terminal-drawer-btn"
              data-testid="terminal-drawer-interrupt"
              onClick={onInterrupt}
            >
              Ctrl+C
            </button>
          ) : null}
          {liveStatus === "error" ? (
            <button
              type="button"
              className="ghost terminal-drawer-btn"
              data-testid="terminal-drawer-reconnect"
              onClick={onReconnect}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="ghost terminal-drawer-btn"
            data-testid="terminal-drawer-clear"
            onClick={onClear}
          >
            Clear
          </button>
          <button
            type="button"
            className="ghost terminal-drawer-btn"
            data-testid="terminal-drawer-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>

      {showLiveShell ? (
        <div className="terminal-live-shell" data-testid="terminal-live-shell">
          <pre
            className="terminal-live-output"
            data-testid="terminal-live-output"
          >
            {liveOutput || "$ "}
          </pre>
          <form
            className="terminal-live-composer"
            onSubmit={(event) => {
              event.preventDefault();
              const nextLine = draft.trim();
              if (!nextLine) return;
              onSendLine(nextLine);
              setDraft("");
            }}
          >
            <span className="terminal-live-prompt">$</span>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="terminal-live-input"
              data-testid="terminal-live-input"
              placeholder={
                liveStatus === "connecting"
                  ? "Waiting for shell…"
                  : "Type a shell command"
              }
              disabled={liveStatus === "connecting" || liveStatus === "closed"}
            />
            <button
              type="submit"
              className="terminal-live-send"
              disabled={liveStatus === "connecting" || liveStatus === "closed"}
            >
              Run
            </button>
          </form>
        </div>
      ) : commands.length === 0 ? (
        <div
          className="terminal-live-unavailable"
          data-testid="terminal-live-unavailable"
        >
          <p className="terminal-empty-copy" data-testid="terminal-empty-copy">
            {liveError.trim()
              ? `Live project terminal is unavailable: ${liveError.trim()}`
              : "Command output will appear here when Codex runs tools in this project."}
          </p>
        </div>
      ) : (
        <div
          className="terminal-command-list"
          data-testid="terminal-command-list"
        >
          {commands.map((command) => (
            <article
              key={command.id}
              className={`terminal-command-card terminal-command-${command.state}`}
            >
              <header>
                <div>
                  <strong>{command.title}</strong>
                  <p>{command.command}</p>
                  <div className="terminal-command-meta">
                    {command.processId.trim() ? (
                      <span>{command.processId}</span>
                    ) : null}
                    {command.interactions.length > 0 ? (
                      <span>{command.interactions.length} inputs</span>
                    ) : null}
                  </div>
                </div>
                <time>{command.timestamp}</time>
              </header>
              {command.interactions.length > 0 ? (
                <div className="terminal-command-interactions">
                  {command.interactions.map((stdin, index) => (
                    <code key={`${command.id}:stdin:${index}`}>{stdin}</code>
                  ))}
                </div>
              ) : null}
              {command.output ? (
                <pre className="terminal-command-output">{command.output}</pre>
              ) : (
                <p className="terminal-command-empty">No command output yet.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
