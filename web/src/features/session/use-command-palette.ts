import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type UseCommandPaletteOptions = {
  sessionModeActive: boolean;
  getFilteredActionsLength: () => number;
  onRunActionAt: (index: number) => void;
  onFocusComposer: () => void;
};

export function useCommandPaletteController({
  sessionModeActive,
  getFilteredActionsLength,
  onRunActionAt,
  onFocusComposer,
}: UseCommandPaletteOptions) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (sessionModeActive) return;
    if (!open) return;
    setOpen(false);
    setQuery("");
    setCursor(0);
  }, [sessionModeActive, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const filteredActionsLength = getFilteredActionsLength();
    setCursor((prev) => {
      if (filteredActionsLength === 0) return 0;
      if (prev < filteredActionsLength) return prev;
      return filteredActionsLength - 1;
    });
  }, [open, getFilteredActionsLength]);

  function openCommandPalette(initialQuery = "") {
    if (!sessionModeActive) return;
    setQuery(initialQuery);
    setCursor(0);
    setOpen(true);
  }

  function closeCommandPalette(options?: { focusComposer?: boolean }) {
    setOpen(false);
    setQuery("");
    setCursor(0);
    if (options?.focusComposer === false) return;
    onFocusComposer();
  }

  function runCommandPaletteAction(index: number) {
    onRunActionAt(index);
    closeCommandPalette({ focusComposer: false });
  }

  function onCommandPaletteKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((prev) => {
        const filteredActionsLength = getFilteredActionsLength();
        if (filteredActionsLength === 0) return 0;
        return (prev + 1) % filteredActionsLength;
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((prev) => {
        const filteredActionsLength = getFilteredActionsLength();
        if (filteredActionsLength === 0) return 0;
        return (prev - 1 + filteredActionsLength) % filteredActionsLength;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runCommandPaletteAction(cursor);
    }
  }

  function onQueryChange(value: string) {
    setQuery(value);
    setCursor(0);
  }

  return {
    commandPaletteOpen: open,
    commandPaletteQuery: query,
    commandPaletteCursor: cursor,
    commandPaletteInputRef: inputRef,
    setCommandPaletteCursor: setCursor,
    openCommandPalette,
    closeCommandPalette,
    runCommandPaletteAction,
    onCommandPaletteKeyDown,
    onCommandPaletteQueryChange: onQueryChange,
  };
}
