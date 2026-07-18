import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  type TerminalSession,
  getToken,
} from "../../api/client";
import { terminalSocketURL } from "../../lib/terminal";
import { getTerminalTheme, observeThemeChanges } from "./terminalTheme";

type Props = {
  session: TerminalSession;
  active: boolean;
  onExit: (id: string, exitCode: number) => void;
  onConnectionChange: (
    id: string,
    status: "connecting" | "connected" | "disconnected",
  ) => void;
};

type WSMessage =
  | { type: "ready"; session: TerminalSession }
  | { type: "exit"; exit_code: number }
  | { type: "error"; message: string };

// Text message parser with type guard
function parseWSTextMessage(data: string): WSMessage | null {
  try {
    const msg = JSON.parse(data);
    if (
      msg &&
      typeof msg === "object" &&
      typeof msg.type === "string"
    ) {
      return msg as WSMessage;
    }
  } catch {
    // ignore
  }
  return null;
}

export default function TerminalView({
  session,
  active,
  onExit,
  onConnectionChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const textEncoderRef = useRef(new TextEncoder());

  const [exited, setExited] = useState(false);

  // Backoff delays: 250ms, 500ms, 1s, 5s, 5s, ...
  const getBackoffDelay = useCallback((attempt: number): number => {
    const delays = [250, 500, 1000, 5000];
    return delays[Math.min(attempt, delays.length - 1)];
  }, []);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (exited) return;
    if (!containerRef.current || !terminalRef.current) return;

    const token = getToken();
    if (!token) {
      onConnectionChange(session.id, "disconnected");
      return;
    }

    onConnectionChange(session.id, "connecting");

    try {
      const url = terminalSocketURL(
        window.location.protocol,
        window.location.host,
        session.id,
        token,
      );
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        wsRef.current = ws;
        reconnectAttemptsRef.current = 0;
        onConnectionChange(session.id, "connected");
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          // Text frame: control message
          const msg = parseWSTextMessage(event.data);
          if (!msg) return;

          if (msg.type === "ready") {
            // Reset terminal on ready to prevent duplicated output after reconnect
            terminalRef.current?.clear();
          } else if (msg.type === "exit") {
            if (typeof msg.exit_code === "number") {
              setExited(true);
              onExit(session.id, msg.exit_code);
            }
          }
          // Ignore error type in normal flow; connection drop handles it
        } else {
          // Binary frame: PTY output
          const uint8 = new Uint8Array(event.data);
          terminalRef.current?.write(uint8);
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!exited) {
          onConnectionChange(session.id, "disconnected");
          // Schedule reconnect with backoff
          const delay = getBackoffDelay(reconnectAttemptsRef.current);
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (err) {
      onConnectionChange(session.id, "disconnected");
      const delay = getBackoffDelay(reconnectAttemptsRef.current);
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    }
  }, [session.id, exited, onConnectionChange, onExit, getBackoffDelay]);

  // Initialize terminal on first mount
  useEffect(() => {
    if (terminalRef.current) return; // Already initialized

    const terminal = new Terminal({
      scrollback: 5000,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    if (containerRef.current) {
      terminal.open(containerRef.current);
    }

    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    // Handle terminal input
    const dataDisposable = terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const uint8 = textEncoderRef.current.encode(data);
        wsRef.current.send(uint8);
      }
    });

    // Observe theme changes
    const unsubscribeTheme = observeThemeChanges((theme) => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = theme;
      }
    });

    // Keyboard event handler for special keys
    terminal.attachCustomKeyEventHandler((event) => {
      // Ctrl+Backquote: let AppShell handle it
      if ((event.ctrlKey || event.metaKey) && event.code === "Backquote") {
        return false;
      }

      // macOS Cmd+C: copy selection if available
      if (event.metaKey && event.code === "KeyC") {
        const selection = terminal.getSelection();
        if (selection) {
          // Let clipboard API handle it asynchronously
          navigator.clipboard?.writeText(selection).catch(() => {
            // silently fail
          });
          return false; // Prevent terminal's default handling
        }
        // Without selection, allow Ctrl+C through for shell interrupt
      }

      // Cmd+V or Ctrl+Shift+V: paste from clipboard
      if (
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.code === "KeyV"
      ) {
        navigator.clipboard?.readText().then((text) => {
          if (terminalRef.current) {
            terminalRef.current.paste(text);
          }
        }).catch(() => {
          // Clipboard unavailable; allow the event to propagate if the terminal
          // has its own paste handling (unlikely in xterm)
        });
        return false; // Prevent terminal's default
      }

      return true; // Allow other keys
    });

    return () => {
      dataDisposable.dispose();
      unsubscribeTheme();
      // Don't dispose terminal/fitAddon yet; we keep them mounted
    };
  }, []);

  // Fit and focus when active changes
  useEffect(() => {
    if (!active || !terminalRef.current || !fitRef.current) return;

    // Schedule fit after layout
    const fitFrame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // Fit may fail if container is hidden
      }
    });

    return () => cancelAnimationFrame(fitFrame);
  }, [active]);

  // ResizeObserver for container resize
  useEffect(() => {
    if (!containerRef.current) return;

    let resizeFrame: number | null = null;
    const handleResize = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (
          containerRef.current &&
          terminalRef.current &&
          fitRef.current &&
          containerRef.current.offsetHeight > 0
        ) {
          try {
            fitRef.current.fit();

            // Send resize control if dimensions changed
            const cols = terminalRef.current.cols;
            const rows = terminalRef.current.rows;
            if (cols > 0 && rows > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({ type: "resize", cols, rows }),
              );
            }
          } catch {
            // Fit may fail if container is hidden
          }
        }
      });
    };

    const observer = new ResizeObserver(handleResize);
    observer.observe(containerRef.current);
    resizeObserverRef.current = observer;

    return () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, []);

  // Connect on mount and clean up on unmount
  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      // Don't dispose terminal; it's kept for re-mounting
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="kin-terminal w-full h-full bg-[var(--kin-bg)] overflow-hidden"
    />
  );
}
