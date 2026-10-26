const VERSION = 2;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;
const MAX_CLIENTS = 8;
const MAX_PENDING = 64;
const REQUEST_TIMEOUT = 60_000;
const CREDENTIAL_COOKIE = "kin_relay";
const CREDENTIAL_MAX_AGE = 60 * 60 * 24 * 30;

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

// The relay authenticates by query string, and a browser does not carry a query
// across a document boundary. Anything the browser builds on its own — a reload,
// a PWA launch from start_url, the URL a module loader derives for a lazily
// imported chunk — therefore arrives with no credentials and is refused here,
// before the daemon ever sees it. The cookie is that same credential kept where
// the browser attaches it by itself; the query stays the bootstrap that sets it.
function encodeCredential(room, key) {
  return `${encodeURIComponent(room)}|${encodeURIComponent(key)}`;
}

export function decodeCredential(value) {
  if (typeof value !== "string") return null;
  const at = value.indexOf("|");
  if (at < 0) return null;
  try {
    const room = decodeURIComponent(value.slice(0, at));
    const key = decodeURIComponent(value.slice(at + 1));
    return room && key ? { room, key } : null;
  } catch {
    return null;
  }
}

export function readCredentialCookie(request) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  // Every part is looked at, not just the first one that is named right: a
  // second cookie of the same name can arrive from a longer path or a sibling
  // host, and stopping at a malformed one would throw away a credential the
  // browser did send — leaving a request that cannot load the console at all,
  // for a reason nothing on the page can see.
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== CREDENTIAL_COOKIE) continue;
    const decoded = decodeCredential(part.slice(at + 1).trim());
    if (decoded) return decoded;
  }
  return null;
}

// Deliberately not HttpOnly. The credential in it is one the console already
// keeps in localStorage, and the console has to be able to drop this cookie in
// the same gesture that drops that copy — otherwise "disconnect" would leave a
// browser that can still reach the relay.
export function credentialCookie(room, key) {
  return `${CREDENTIAL_COOKIE}=${encodeCredential(room, key)}; Path=/; `
    + `Max-Age=${CREDENTIAL_MAX_AGE}; Secure; SameSite=Lax`;
}

function withCredential(request, credential) {
  const url = new URL(request.url);
  url.searchParams.set("room", credential.room);
  url.searchParams.set("key", credential.key);
  return new Request(url, request);
}

function withCredentialCookie(response, credential) {
  const carried = new Response(response.body, response);
  carried.headers.append("Set-Cookie", credentialCookie(credential.room, credential.key));
  return carried;
}

function isUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

// A top-level document load, as reported by the browser itself. `Dest` is the
// precise one; `Mode` covers a browser that reports the mode but not the
// destination. Either way the page cannot forge it, which is the whole point —
// see the note where this is used.
function isDocumentRequest(request) {
  const headers = request.headers;
  const dest = headers.get("Sec-Fetch-Dest");
  if (dest) return dest === "document";
  return headers.get("Sec-Fetch-Mode") === "navigate";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");
    const key = url.searchParams.get("key");
    // A URL that names a credential keeps naming it, whichever half it names.
    // The daemon hands out room-only links on purpose (`relay.connect_url` is the
    // URL without credentials), and a browser that happens to hold a cookie for a
    // different room must not turn such a link into a request for the room it
    // already knows — the address bar would say one room and the data would come
    // from another. A room-only link reaches its own room and takes that room's
    // 401, which is what it did before any cookie existed. Neither does a link
    // that names only a key get that key swapped for the cookie's: there is no
    // room in it to serve, so it is refused here rather than answered from
    // somewhere else. The cookie is a fallback for the requests that name no
    // credential at all: a reload, a PWA launch, an asset.
    //
    // A socket upgrade keeps reading its credential from the query alone: the
    // upgrade only survives on the request the runtime handed us, and rebuilding
    // it to add a query is exactly the thing that can drop it. Every socket
    // client already builds its URL from the console's relay helper, so the
    // query is there.
    const credential = isUpgrade(request) || room
      ? { room, key }
      : (key ? {} : (readCredentialCookie(request) ?? {}));
    if (!credential.room || credential.room.length > 128) {
      return json({ error: "room is required" }, 400);
    }
    // Without a key the room cannot be served, but a room-addressed request is
    // still the one that gets the 401 from the room itself rather than a 400
    // from here — that is today's behaviour and it stays.
    const forwarded = room === credential.room && key === credential.key
      ? request
      : withCredential(request, credential);
    const response = await env.RELAY_ROOM.get(
      env.RELAY_ROOM.idFromName(credential.room),
    ).fetch(forwarded);
    // Only a request for a document needs the cookie issued. That request is
    // the one that arrives with nothing but headers — a reload, a PWA launch
    // from start_url — so it is both the request that must find the cookie
    // present and the only one worth spending a write on. XHRs are built by the
    // console from the relay URL it already holds, query included, and assets
    // are fetched with the cookie they already have; reissuing on those would
    // add a write to every response that the browser discards unread. Renewing
    // here is also what keeps the 30-day window sliding for a phone that is
    // opened, not re-paired.
    //
    // What counts as a document has to be something the page cannot claim for
    // itself. `Accept: text/html` looks like the natural test and is the wrong
    // one: a script can set it, so any script on this origin — or a cross-site
    // request that survives the browser's third-party cookie rules — could hand
    // this worker a room of its choosing and have it written as the phone's
    // credential for 30 days. The `Sec-Fetch-*` headers are forbidden header
    // names: the browser writes them and a page cannot. Measured in Chromium, a
    // document is `Dest: document, Mode: navigate`, while the entry chunk, the
    // lazily imported chunks and every XHR are `Dest: script|empty, Mode: cors`.
    //
    // The cost is a browser old enough to send no `Sec-Fetch-*` at all: it gets
    // no cookie and keeps the failure it has today. That is the right way round
    // for a credential — the alternative fails open, and a phone that cannot
    // reload yet is a smaller problem than a phone whose console answers to
    // someone else's room.
    //
    // A 401 is the room saying it does not recognise this key, so a request
    // carrying one must not be the one that writes the cookie: opening a stale
    // link once would otherwise replace a working credential and leave every
    // later reload refused before the console could even load to recover.
    //
    // Never wrap an upgrade: the response to one carries the accepted socket,
    // and rebuilding it to append a header drops the socket and hangs the
    // client. Nothing is lost — a socket client already has the query.
    const wantsDocument = isDocumentRequest(request) && !isUpgrade(request);
    if (wantsDocument && response.status !== 401) {
      return withCredentialCookie(response, credential);
    }
    return response;
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
