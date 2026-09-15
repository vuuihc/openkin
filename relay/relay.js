// relay.js — Cloudflare Workers WebSocket relay for Kin
// Deploy: wrangler deploy relay.js --name kin-relay

// Room state: { daemon: WebSocket|null, requests: Map<reqId, {resolve,reject,timeout}> }
const rooms = new Map();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room') || 'default';

    // WebSocket handshake
    const upgrade = request.headers.get('Upgrade');
    if (upgrade === 'websocket') {
      return handleWebSocket(request, room);
    }

    // HTTPS REST API — forward to daemon via WSS, wait for response
    return handleHTTP(request, room);
  }
};

async function handleWebSocket(request, room) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let state = rooms.get(room);
  if (!state) {
    state = { daemon: null, client: null, requests: new Map() };
    rooms.set(room, state);
  }

  const isDaemon = new URL(request.url).searchParams.get('role') === 'daemon';

  if (isDaemon) {
    state.daemon = server;
    // Replay any pending requests that arrived before the daemon connected
    for (const [reqId, pending] of state.requests) {
      server.send(JSON.stringify({
        type: 'request',
        reqId,
        method: pending.method,
        path: pending.path,
        headers: pending.headers,
        body: pending.body
      }));
    }
  } else {
    state.client = server;
  }

  server.addEventListener('message', async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'response') {
      const pending = state.requests?.get(msg.reqId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(new Response(msg.body, {
          status: msg.status || 200,
          headers: { 'Content-Type': 'application/json' }
        }));
        state.requests.delete(msg.reqId);
      }
    } else if (msg.type === 'request' && state.daemon?.readyState === 1) {
      // Client request → forward to daemon
      state.daemon.send(event.data);
    } else if (state.daemon?.readyState === 1 && state.client?.readyState === 1) {
      // Generic bidirectional relay
      const target = server === state.daemon ? state.client : state.daemon;
      if (target?.readyState === 1) {
        target.send(event.data);
      }
    }
  });

  server.addEventListener('close', () => {
    if (isDaemon) {
      state.daemon = null;
    } else {
      state.client = null;
    }
    // Clean up empty rooms
    if (!state.daemon && !state.client) {
      rooms.delete(room);
    }
  });

  server.addEventListener('error', () => {
    if (isDaemon) {
      state.daemon = null;
    } else {
      state.client = null;
    }
    if (!state.daemon && !state.client) {
      rooms.delete(room);
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function handleHTTP(request, room) {
  const state = rooms.get(room);
  if (!state?.daemon || state.daemon.readyState !== 1) {
    return new Response(JSON.stringify({ error: 'daemon offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const reqId = crypto.randomUUID();
  const body = await request.text();

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (state.requests.has(reqId)) {
        state.requests.delete(reqId);
        resolve(new Response(JSON.stringify({ error: 'timeout' }), {
          status: 504,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
    }, 60000);

    state.requests.set(reqId, {
      resolve,
      timeout,
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      headers: Object.fromEntries(request.headers),
      body: body || undefined
    });

    state.daemon.send(JSON.stringify({
      type: 'request',
      reqId,
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      headers: Object.fromEntries(request.headers),
      body: body || undefined
    }));
  });
}