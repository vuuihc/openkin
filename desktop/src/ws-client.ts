import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { createHash, randomBytes } from "node:crypto";
import { DAEMON_WS } from "./config";
import type { WSMessage } from "./daemon-api";

export type WSHandlers = {
  onMessage: (msg: WSMessage) => void;
  onStatus: (status: "connected" | "disconnected" | "connecting") => void;
};

/**
 * Main-process WebSocket client for the Kin daemon.
 *
 * Auth: same as the web UI — `?token=` query param
 * (`internal/remote/auth.go` extractToken).
 *
 * Implementation note: Electron's embedded Node does not expose a global
 * `WebSocket`, and we allow no runtime npm deps beyond Electron. This is a
 * minimal RFC6455 client (text frames only) over loopback HTTP.
 */
export class DaemonWS {
  private socket: Socket | null = null;
  private token: string | null = null;
  private handlers: WSHandlers;
  private closed = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private buf = Buffer.alloc(0);
  private headerDone = false;

  constructor(handlers: WSHandlers) {
    this.handlers = handlers;
  }

  connect(token: string): void {
    this.token = token;
    this.closed = false;
    this.open();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.handlers.onStatus("disconnected");
  }

  private open(): void {
    if (this.closed || !this.token) return;
    this.handlers.onStatus("connecting");
    const url = new URL(DAEMON_WS);
    url.searchParams.set("token", this.token);
    console.log("[kin-desktop] WS connecting", DAEMON_WS);

    const isTLS = url.protocol === "wss:";
    const port = Number(url.port) || (isTLS ? 443 : 80);
    const host = url.hostname;
    const path = `${url.pathname}${url.search}`;

    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    const onConnected = (sock: Socket) => {
      this.socket = sock;
      this.buf = Buffer.alloc(0);
      this.headerDone = false;

      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`;
      sock.write(req);

      sock.on("data", (chunk: Buffer) => this.onData(chunk, expectedAccept));
      sock.on("error", (err) => {
        console.warn("[kin-desktop] WS socket error", err.message);
        this.failAndReconnect();
      });
      sock.on("close", () => {
        if (this.socket === sock) {
          this.socket = null;
          this.handlers.onStatus("disconnected");
          this.scheduleReconnect();
        }
      });
    };

    try {
      if (isTLS) {
        const sock = tlsConnect({ host, port, servername: host }, () =>
          onConnected(sock),
        );
        sock.on("error", (err) => {
          console.warn("[kin-desktop] WS tls error", err.message);
          this.failAndReconnect();
        });
      } else {
        const sock = netConnect({ host, port }, () => onConnected(sock));
        sock.on("error", (err) => {
          console.warn("[kin-desktop] WS net error", err.message);
          this.failAndReconnect();
        });
      }
    } catch (err) {
      console.error("[kin-desktop] WS construct failed", err);
      this.scheduleReconnect();
    }
  }

  private onData(chunk: Buffer, expectedAccept: string): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.headerDone) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const header = this.buf.subarray(0, idx).toString("utf8");
      this.buf = this.buf.subarray(idx + 4);
      this.headerDone = true;
      if (!/^HTTP\/1\.1 101/i.test(header)) {
        console.warn(
          "[kin-desktop] WS handshake failed:",
          header.split("\r\n")[0],
        );
        this.failAndReconnect();
        return;
      }
      const accept = header
        .split("\r\n")
        .find((l) => /^sec-websocket-accept:/i.test(l))
        ?.split(":")[1]
        ?.trim();
      if (accept !== expectedAccept) {
        console.warn("[kin-desktop] WS accept mismatch");
        this.failAndReconnect();
        return;
      }
      console.log("[kin-desktop] WS connected");
      this.backoffMs = 1000;
      this.handlers.onStatus("connected");
    }
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        // Only support lengths that fit in JS number safely for our use.
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          console.warn("[kin-desktop] WS frame too large");
          this.failAndReconnect();
          return;
        }
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i] ^ mask[i % 4];
        }
        payload = out;
      }
      this.buf = this.buf.subarray(off + maskLen + len);

      if (opcode === 0x8) {
        // close
        this.teardownSocket();
        return;
      }
      if (opcode === 0x9) {
        // ping → pong
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        // pong
        continue;
      }
      if (opcode === 0x1) {
        // text
        try {
          const msg = JSON.parse(payload.toString("utf8")) as WSMessage;
          this.handlers.onMessage(msg);
        } catch (err) {
          console.warn("[kin-desktop] WS bad message", err);
        }
      }
      // binary / continuation ignored
    }
  }

  /** Client-to-server frames MUST be masked (RFC6455). */
  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket) return;
    const mask = randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private failAndReconnect(): void {
    this.teardownSocket();
    this.handlers.onStatus("disconnected");
    this.scheduleReconnect();
  }

  private teardownSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
  }
}
