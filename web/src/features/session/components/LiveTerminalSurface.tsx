import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

type LiveTerminalSurfaceProps = {
  output: string;
  status: "idle" | "connecting" | "live" | "closed" | "error";
  onSendInput: (data: string) => void;
  onResize: (rows: number, cols: number) => void;
};

const terminalFontFamily =
  "SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace";

export function LiveTerminalSurface({
  output,
  status,
  onSendInput,
  onResize,
}: LiveTerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<{
    options: { cursorBlink?: boolean };
    rows: number;
    cols: number;
    loadAddon: (addon: any) => void;
    open: (element: HTMLElement) => void;
    focus: () => void;
    write: (data: string) => void;
    reset: () => void;
    onData: (handler: (data: string) => void) => { dispose: () => void };
    dispose: () => void;
  } | null>(null);
  const fitAddonRef = useRef<{
    fit: () => void;
    dispose: () => void;
  } | null>(null);
  const outputLengthRef = useRef(0);
  const resizeFrameRef = useRef<number | null>(null);
  const [moduleState, setModuleState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let cleanup = () => {};

    setModuleState("loading");
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([xtermModule, fitAddonModule]) => {
        if (cancelled) return;
        const terminal = new xtermModule.Terminal({
          allowTransparency: false,
          convertEol: false,
          cursorBlink: status === "live",
          cursorStyle: "block",
          fontFamily: terminalFontFamily,
          fontSize: 13,
          lineHeight: 1.35,
          scrollback: 5000,
          theme: {
            background: "#0a1120",
            foreground: "#edf2fb",
            cursor: "#edf2fb",
            cursorAccent: "#0a1120",
            black: "#0a1120",
            red: "#f38b82",
            green: "#8dd58a",
            yellow: "#f2c66d",
            blue: "#8ab4ff",
            magenta: "#caa8ff",
            cyan: "#8ce0e8",
            white: "#edf2fb",
            brightBlack: "#41506b",
            brightRed: "#ffb4ab",
            brightGreen: "#b7f1b2",
            brightYellow: "#f8dc9a",
            brightBlue: "#b2ccff",
            brightMagenta: "#ddcbff",
            brightCyan: "#bbf5fa",
            brightWhite: "#ffffff",
          },
        });
        const fitAddon = new fitAddonModule.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        const scheduleResize = () => {
          if (!terminalRef.current || !fitAddonRef.current) return;
          if (resizeFrameRef.current !== null) {
            cancelAnimationFrame(resizeFrameRef.current);
          }
          resizeFrameRef.current = requestAnimationFrame(() => {
            resizeFrameRef.current = null;
            fitAddonRef.current?.fit();
            onResize(
              terminalRef.current?.rows ?? 0,
              terminalRef.current?.cols ?? 0,
            );
          });
        };

        scheduleResize();
        terminal.focus();
        setModuleState("ready");

        const disposeData = terminal.onData((data) => {
          onSendInput(data);
        });
        const focusTerminal = () => {
          terminal.focus();
        };
        container.addEventListener("pointerdown", focusTerminal);
        const resizeObserver =
          typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => {
                scheduleResize();
              })
            : null;
        resizeObserver?.observe(container);

        cleanup = () => {
          container.removeEventListener("pointerdown", focusTerminal);
          resizeObserver?.disconnect();
          disposeData.dispose();
          if (resizeFrameRef.current !== null) {
            cancelAnimationFrame(resizeFrameRef.current);
            resizeFrameRef.current = null;
          }
          fitAddon.dispose();
          terminal.dispose();
          fitAddonRef.current = null;
          terminalRef.current = null;
          outputLengthRef.current = 0;
        };
      })
      .catch(() => {
        if (cancelled) return;
        setModuleState("error");
      });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [onResize, onSendInput]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = status === "live";
  }, [status]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (output.length < outputLengthRef.current) {
      terminal.reset();
      outputLengthRef.current = 0;
    }
    if (output.length > outputLengthRef.current) {
      terminal.write(output.slice(outputLengthRef.current));
      outputLengthRef.current = output.length;
    }
  }, [output]);

  return (
    <div className="terminal-live-shell" data-testid="terminal-live-shell">
      {moduleState === "loading" ? (
        <p className="terminal-live-status-copy">Preparing terminal…</p>
      ) : null}
      {moduleState === "error" ? (
        <p className="terminal-live-status-copy">
          Terminal view could not load.
        </p>
      ) : null}
      <div
        ref={containerRef}
        className="terminal-live-viewport"
        data-testid="terminal-live-output"
      />
    </div>
  );
}
