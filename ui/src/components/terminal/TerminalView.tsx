import { useCallback, useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getToken, type TerminalSession } from "../../api/client";
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

const RECONNECT_DELAYS = [250, 500, 1000, 5000] as const;

function parseWSTextMessage(data: string): WSMessage | null {
  try {
    const message: unknown = JSON.parse(data);
    if (!message || typeof message !== "object" || !("type" in message)) {
      return null;
    }
    const type = message.type;
    if (type === "ready" && "session" in message) {
      return message as WSMessage;
    }
    if (
      type === "exit" &&
      "exit_code" in message &&
      typeof message.exit_code === "number"
    ) {
      return message as WSMessage;
    }
    if (
      type === "error" &&
      "message" in message &&
      typeof message.message === "string"
    ) {
      return message as WSMessage;
    }
  } catch {
    // Ignore malformed server controls; binary PTY output remains independent.
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const textEncoderRef = useRef(new TextEncoder());
  const mountedRef = useRef(false);
  const knownExitedRef = useRef(false);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const onExitRef = useRef(onExit);
  const onConnectionChangeRef = useRef(onConnectionChange);

  onExitRef.current = onExit;
  onConnectionChangeRef.current = onConnectionChange;

  const sendCurrentResize = useCallback(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    const socket = wsRef.current;
    if (
      !container ||
      !terminal ||
      container.offsetWidth <= 0 ||
      container.offsetHeight <= 0 ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const next = { cols: terminal.cols, rows: terminal.rows };
    if (next.cols <= 0 || next.rows <= 0) return;
    const previous = lastResizeRef.current;
    if (previous?.cols === next.cols && previous.rows === next.rows) return;
    lastResizeRef.current = next;
    socket.send(JSON.stringify({ type: "resize", ...next }));
  }, []);

  const fitAndResize = useCallback(() => {
    const container = containerRef.current;
    if (
      !container ||
      container.offsetWidth <= 0 ||
      container.offsetHeight <= 0
    ) {
      return;
    }
    try {
      fitRef.current?.fit();
      sendCurrentResize();
    } catch {
      // Fit can race with a hidden panel or a layout transition.
    }
  }, [sendCurrentResize]);

  const connect = useCallback(() => {
    if (!mountedRef.current || knownExitedRef.current) return;
    const currentSocket = wsRef.current;
    if (
      currentSocket?.readyState === WebSocket.CONNECTING ||
      currentSocket?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    const token = getToken();
    if (!token) {
      onConnectionChangeRef.current(session.id, "disconnected");
      return;
    }
    onConnectionChangeRef.current(session.id, "connecting");

    const scheduleReconnect = () => {
      if (!mountedRef.current || knownExitedRef.current) return;
      const attempt = reconnectAttemptsRef.current;
      const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    try {
      const socket = new WebSocket(
        terminalSocketURL(
          window.location.protocol,
          window.location.host,
          session.id,
          token,
        ),
      );
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;

      socket.onopen = () => {
        if (!mountedRef.current || wsRef.current !== socket) {
          socket.close();
          return;
        }
        reconnectAttemptsRef.current = 0;
        lastResizeRef.current = null;
        onConnectionChangeRef.current(session.id, "connected");
      };

      socket.onmessage = (event) => {
        if (wsRef.current !== socket) return;
        if (typeof event.data === "string") {
          const message = parseWSTextMessage(event.data);
          if (message?.type === "ready") {
            terminalRef.current?.reset();
            lastResizeRef.current = null;
            requestAnimationFrame(fitAndResize);
          } else if (message?.type === "exit") {
            knownExitedRef.current = true;
            onExitRef.current(session.id, message.exit_code);
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          terminalRef.current?.write(new Uint8Array(event.data));
        }
      };

      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        if (!mountedRef.current || knownExitedRef.current) return;
        onConnectionChangeRef.current(session.id, "disconnected");
        scheduleReconnect();
      };

      socket.onerror = () => socket.close();
    } catch {
      onConnectionChangeRef.current(session.id, "disconnected");
      scheduleReconnect();
    }
  }, [fitAndResize, session.id]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    mountedRef.current = true;

    const terminal = new Terminal({
      scrollback: 5000,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: getTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const dataDisposable = terminal.onData((data) => {
      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(textEncoderRef.current.encode(data));
      }
    });
    const unsubscribeTheme = observeThemeChanges((theme) => {
      if (terminalRef.current) terminalRef.current.options.theme = theme;
    });

    terminal.attachCustomKeyEventHandler((event) => {
      // xterm invokes this for keydown, keypress, and keyup. Clipboard side
      // effects must run once (keydown only). Returning false only skips
      // xterm's own handling — also preventDefault so the browser paste/copy
      // event does not fire a second time into the xterm textarea.
      const isKeyDown = event.type === "keydown";
      if (event.ctrlKey && !event.metaKey && event.code === "Backquote") {
        return false;
      }
      if (event.metaKey && event.code === "KeyC") {
        const selection = terminal.getSelection();
        if (selection) {
          if (isKeyDown) {
            event.preventDefault();
            void navigator.clipboard?.writeText(selection).catch(() => undefined);
          }
          return false;
        }
      }
      if (
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.code === "KeyV"
      ) {
        const readText = navigator.clipboard?.readText;
        if (!readText) return true;
        if (isKeyDown) {
          event.preventDefault();
          void readText.call(navigator.clipboard).then(
            (text) => terminalRef.current?.paste(text),
            () => undefined,
          );
        }
        return false;
      }
      return true;
    });

    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fitAndResize);
    });
    observer.observe(container);

    connect();
    return () => {
      mountedRef.current = false;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      observer.disconnect();
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      dataDisposable.dispose();
      unsubscribeTheme();
      fitAddon.dispose();
      terminal.dispose();
      fitRef.current = null;
      terminalRef.current = null;
    };
  }, [connect, fitAndResize]);

  useEffect(() => {
    if (!active) {
      terminalRef.current?.blur();
      return;
    }
    const frame = requestAnimationFrame(() => {
      fitAndResize();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fitAndResize]);

  return (
    <div
      ref={containerRef}
      className="kin-terminal h-full w-full overflow-hidden bg-[var(--kin-bg)]"
    />
  );
}
