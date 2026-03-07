import type { TimelineState } from "../../../domains/session";

type TerminalCommandEntry = {
  id: string;
  title: string;
  command: string;
  output: string;
  timestamp: string;
  state: TimelineState;
};

type SessionTerminalDrawerProps = {
  workdir: string;
  hostLabel: string;
  commands: TerminalCommandEntry[];
  onClose: () => void;
  onClear: () => void;
};

export function SessionTerminalDrawer({
  workdir,
  hostLabel,
  commands,
  onClose,
  onClear,
}: SessionTerminalDrawerProps) {
  const context = [workdir.trim(), hostLabel.trim()].filter(Boolean).join(" · ");

  return (
    <section className="terminal-drawer" data-testid="terminal-drawer">
      <div className="terminal-drawer-head">
        <div className="terminal-drawer-copy">
          <p className="terminal-drawer-eyebrow">Project terminal</p>
          <h3>Terminal</h3>
          <p className="terminal-drawer-context">{context || "Current project"}</p>
        </div>
        <div className="terminal-drawer-actions">
          <span className="terminal-drawer-shortcut">Ctrl+L clears</span>
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

      {commands.length === 0 ? (
        <p className="terminal-empty-copy" data-testid="terminal-empty-copy">
          Command output will appear here when Codex runs tools in this project.
        </p>
      ) : (
        <div className="terminal-command-list" data-testid="terminal-command-list">
          {commands.map((command) => (
            <article
              key={command.id}
              className={`terminal-command-card terminal-command-${command.state}`}
            >
              <header>
                <div>
                  <strong>{command.title}</strong>
                  <p>{command.command}</p>
                </div>
                <time>{command.timestamp}</time>
              </header>
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
