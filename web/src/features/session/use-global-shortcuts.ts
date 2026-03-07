import { useEffect } from "react";

type UseGlobalShortcutsOptions = {
  authReady: boolean;
  appMode: "session" | "ops";
  commandPaletteOpen: boolean;
  onOpenCommandPalette: () => void;
  onCloseCommandPalette: () => void;
  onCreateThreadAndFocus: () => void;
  onSwitchThreadByOffset: (offset: number) => void;
  terminalDrawerOpen: boolean;
  terminalHasLiveTransport: boolean;
  onToggleTerminalDrawer: () => void;
  onClearTerminalDrawer: () => void;
  onToggleReviewPane: () => void;
};

export function useGlobalShortcuts({
  authReady,
  appMode,
  commandPaletteOpen,
  onOpenCommandPalette,
  onCloseCommandPalette,
  onCreateThreadAndFocus,
  onSwitchThreadByOffset,
  terminalDrawerOpen,
  terminalHasLiveTransport,
  onToggleTerminalDrawer,
  onClearTerminalDrawer,
  onToggleReviewPane,
}: UseGlobalShortcutsOptions) {
  useEffect(() => {
    if (!authReady) return;

    const handleGlobalKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandPaletteOpen) {
          onCloseCommandPalette();
          return;
        }
        onOpenCommandPalette();
        return;
      }

      if (commandPaletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          onCloseCommandPalette();
        }
        return;
      }

      if (appMode !== "session") return;

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "j"
      ) {
        event.preventDefault();
        onToggleTerminalDrawer();
        return;
      }

      if (
        terminalDrawerOpen &&
        !terminalHasLiveTransport &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        onClearTerminalDrawer();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        onToggleReviewPane();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        onCreateThreadAndFocus();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "ArrowUp" || event.key === "[")
      ) {
        event.preventDefault();
        onSwitchThreadByOffset(-1);
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "ArrowDown" || event.key === "]")
      ) {
        event.preventDefault();
        onSwitchThreadByOffset(1);
      }
    };

    window.addEventListener("keydown", handleGlobalKeydown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  }, [
    authReady,
    appMode,
    commandPaletteOpen,
    onCloseCommandPalette,
    onCreateThreadAndFocus,
    onOpenCommandPalette,
    onSwitchThreadByOffset,
    terminalDrawerOpen,
    terminalHasLiveTransport,
    onToggleTerminalDrawer,
    onClearTerminalDrawer,
    onToggleReviewPane,
  ]);
}
