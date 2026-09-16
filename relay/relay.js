const VERSION = 2;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;
const MAX_CLIENTS = 8;
const MAX_PENDING = 64;
const REQUEST_TIMEOUT = 60_000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function envelope(kind, data) {
  return JSON.stringify({ v: VERSION, kind, data });
}

function parseFrame(raw) {
  if (typeof raw !== "string" || raw.length > MAX_FRAME) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.v !== VERSION || typeof value.kind !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    if (!room || room.length > 128) return json({ error: "room is required" }, 400);
    const id = env.RELAY_ROOM.idFromName(room);
    return env.RELAY_ROOM.get(id).fetch(request);
  },
};

export class RelayRoom {
  constructor(state) {
    this.state = state;
    this.daemon = null;
    this.clients = new Map();
    this.pending = new Map();
    this.key = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.acceptSocket(request, key);
    }
    return this.proxyHTTP(request, key);
  }

  async roomKey() {
    if (!this.key) this.key = await this.state.storage.get("relay-key");
    return this.key;
  }

  async acceptSocket(request, suppliedKey) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = new URL(request.url).searchParams.get("role") || "client";
    if (role !== "daemon" && role !== "client") return json({ error: "invalid role" }, 400);
    if (role === "daemon" && !suppliedKey) return json({ error: "relay key is required" }, 401);
    if (role === "daemon" && this.daemon) return json({ error: "daemon already connected" }, 409);
    if (role === "client" && (await this.roomKey()) !== suppliedKey) return json({ error: "unauthorized" }, 401);
    server.accept();

    if (role === "daemon") {
      server.addEventListener("message", (event) =>
        this.onDaemonMessage(
          event,
          server,
          new URL(request.url).searchParams.get("room"),
          suppliedKey,
        )
      );
      server.addEventListener("close", () => this.dropDaemon(server));
      server.addEventListener("error", () => this.dropDaemon(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (this.clients.size >= MAX_CLIENTS) {
      server.close(1013, "client limit");
      return new Response(null, { status: 101, webSocket: client });
    }
    const streamID = crypto.randomUUID();
    this.clients.set(streamID, server);
    server.addEventListener("message", (event) => {
      const frame = parseFrame(event.data);
      if (frame?.kind === "stream_data" || frame?.kind === "close_stream") {
        this.sendDaemon(frame.kind, { ...frame.data, id: streamID });
        return;
      }
      const payload = typeof event.data === "string"
        ? new TextEncoder().encode(event.data)
        : new Uint8Array(event.data);
      if (payload.byteLength <= MAX_FRAME) {
        this.sendDaemon("stream_data", {
          id: streamID,
          payload: bytesToBase64(payload),
          binary: typeof event.data !== "string",
        });
      }
    });
    server.addEventListener("close", () => {
      this.clients.delete(streamID);
      this.sendDaemon("close_stream", { id: streamID });
    });
    if (!this.daemon || this.daemon.readyState !== WebSocket.OPEN) {
      server.close(1013, "daemon offline");
    } else {
      const headers = {};
      for (const name of ["authorization", "x-client-type"]) {
        const value = request.headers.get(name);
        if (value) headers[name] = value;
      }
      if (!headers.authorization) {
        const token = new URL(request.url).searchParams.get("token");
        if (token) headers.authorization = `Bearer ${token}`;
      }
      this.sendDaemon("open_stream", { id: streamID, headers });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async onDaemonMessage(event, socket, room, suppliedKey) {
    const frame = parseFrame(event.data);
    if (!frame) return;
    if (frame.kind === "hello") {
      const data = frame.data || {};
      if (data.role !== "daemon" || data.room !== room || !data.key || data.key !== suppliedKey) {
        socket.close(1008, "invalid hello");
        return;
      }
      const saved = await this.roomKey();
      if (saved && saved !== data.key) {
        socket.close(1008, "wrong relay key");
        return;
      }
      if (this.daemon && this.daemon !== socket) {
        socket.close(1008, "daemon already connected");
        return;
      }
      if (!saved) {
        this.key = data.key;
        await this.state.storage.put("relay-key", data.key);
      }
      this.daemon = socket;
      this.sendDaemon("ready", { room: data.room });
      return;
    }
    if (frame.kind === "response") {
      const pending = this.pending.get(frame.data?.id);
      if (!pending) return;
      this.pending.delete(frame.data.id);
      clearTimeout(pending.timer);
      pending.resolve(frame.data);
      return;
    }
    if (frame.kind === "stream_data" || frame.kind === "close_stream") {
      const socket = this.clients.get(frame.data?.id);
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (frame.kind === "close_stream") {
        socket.close(1000, "stream closed");
        return;
      }
      const payload = base64ToBytes(frame.data?.payload || "");
      socket.send(frame.data?.binary ? payload : new TextDecoder().decode(payload));
    }
  }

  dropDaemon(socket) {
    if (this.daemon !== socket) return;
    this.daemon = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id, status: 503, error: "daemon offline" });
    }
    this.pending.clear();
    for (const client of this.clients.values()) client.close(1013, "daemon offline");
    this.clients.clear();
  }

  sendDaemon(kind, data) {
    if (this.daemon?.readyState === WebSocket.OPEN) {
      this.daemon.send(envelope(kind, data));
      return true;
    }
    return false;
  }

  async proxyHTTP(request, suppliedKey) {
    const saved = await this.roomKey();
    if (!saved || saved !== suppliedKey) return json({ error: "unauthorized" }, 401);
    if (!this.daemon || this.daemon.readyState !== WebSocket.OPEN) {
      return json({ error: "daemon offline" }, 503);
    }
    if (this.pending.size >= MAX_PENDING) {
      return json({ error: "request queue is full" }, 429);
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return json({ error: "body too large" }, 413);
    const id = crypto.randomUUID();
    const url = new URL(request.url);
    const headers = {};
    for (const [name, value] of request.headers) {
      if (!["host", "connection", "upgrade", "content-length"].includes(name.toLowerCase())) {
        headers[name] = value;
      }
    }
    if (!headers.authorization) {
      const token = url.searchParams.get("token");
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, status: 504, error: "request timeout" });
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, timer });
      if (!this.sendDaemon("request", {
        id,
        method: request.method,
        path: url.pathname + (() => {
          const forwarded = new URLSearchParams(url.search);
          forwarded.delete("room");
          forwarded.delete("key");
          forwarded.delete("role");
          forwarded.delete("token");
          const query = forwarded.toString();
          return query ? `?${query}` : "";
        })(),
        headers,
        body_b64: bytesToBase64(new Uint8Array(body)),
      })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ id, status: 503, error: "daemon offline" });
      }
    });
    const responseHeaders = {};
    for (const [name, value] of Object.entries(result.headers || {})) responseHeaders[name] = value;
    const responseBody = [204, 205].includes(result.status)
      ? null
      : result.body_b64
        ? base64ToBytes(result.body_b64)
        : (result.body || JSON.stringify({ error: result.error || "relay error" }));
    return new Response(responseBody, {
      status: result.status || 502,
      headers: responseHeaders,
    });
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
