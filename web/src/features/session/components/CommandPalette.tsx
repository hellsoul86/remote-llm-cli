import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";

type CommandPaletteItem = {
  id: string;
  label: string;
  detail: string;
};

type CommandPaletteProps = {
  open: boolean;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  query: string;
  cursor: number;
  actions: CommandPaletteItem[];
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onHoverAction: (index: number) => void;
  onRunAction: (index: number) => void;
};

export function CommandPalette({
  open,
  inputRef,
  query,
  cursor,
  actions,
  onClose,
  onQueryChange,
  onKeyDown,
  onHoverAction,
  onRunAction,
}: CommandPaletteProps) {
  if (!open) return null;
  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
      >
        <header className="command-palette-head">
          <strong>Command Palette</strong>
          <small>Enter to run · Esc to close</small>
        </header>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type a command..."
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="command-palette-list" role="listbox">
          {actions.length === 0 ? (
            <p className="command-palette-empty">No matching commands.</p>
          ) : (
            actions.map((action, index) => (
              <button
                key={action.id}
                type="button"
                className={`command-palette-item ${index === cursor ? "active" : ""}`}
                onMouseEnter={() => onHoverAction(index)}
                onClick={() => onRunAction(index)}
              >
                <strong>{action.label}</strong>
                <small>{action.detail}</small>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
