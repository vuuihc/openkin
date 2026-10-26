import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  RelayRoom,
  credentialCookie,
  decodeCredential,
  readCredentialCookie,
} from "./relay.js";

const ROOM = "a".repeat(64);
const KEY = "b".repeat(64);

test("relay module parses and exports a Durable Object", () => {
  assert.equal(typeof RelayRoom, "function");
});

test("invalid room requests fail before Durable Object lookup", async () => {
  const env = { RELAY_ROOM: { idFromName() { throw new Error("must not be called"); } } };
  const response = await worker.fetch(new Request("https://relay.example.test/"), env);
  assert.equal(response.status, 400);
});

// Records what the room was asked to serve, so a test can assert on the request
// that actually reached it rather than on the shape of the code that built it.
function recordingEnv(handler) {
  const seen = [];
  return {
    seen,
    RELAY_ROOM: {
      idFromName(name) {
        return `room-id:${name}`;
      },
      get(id) {
        return {
          async fetch(request) {
            seen.push({ id, url: new URL(request.url), request });
            if (handler) return handler(request);
            return new Response("served", { status: 200 });
          },
        };
      },
    },
  };
}

test("an opened relay link teaches the browser the cookie", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(
    new Request(`https://relay.example.test/inbox?room=${ROOM}&key=${KEY}`, {
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    }),
    env,
  );

  assert.equal(response.status, 200);
  // The query path is what works today; it must not start round-tripping
  // through a rebuilt Request.
  assert.equal(env.seen[0].url.searchParams.get("room"), ROOM);
  assert.equal(env.seen[0].url.searchParams.get("key"), KEY);

  const cookie = response.headers.get("Set-Cookie");
  assert.ok(cookie, "a navigation should hand the browser a cookie");
  assert.match(cookie, /^kin_relay=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /HttpOnly/);
});

test("a credentialed XHR is served without rewriting the cookie", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(
    new Request(`https://relay.example.test/api/tasks?room=${ROOM}&key=${KEY}`, {
      headers: { Accept: "application/json" },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(env.seen[0].url.searchParams.get("key"), KEY);
  // The console builds every XHR from the relay URL it already holds, so the
  // query is present on all of them. Reissuing here would put a Set-Cookie the
  // browser has no use for on every API response.
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("a cookie alone is enough, and reaches the room as a credential", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(
    new Request("https://relay.example.test/assets/CodeViewer-abc123.css", {
      headers: { Cookie: credentialCookie(ROOM, KEY) },
    }),
    env,
  );

  assert.equal(response.status, 200);
  // The room reads the key off the query, so a cookie-carried credential that
  // is not put back on the URL arrives as a request the room cannot authorize.
  assert.equal(env.seen[0].url.searchParams.get("room"), ROOM);
  assert.equal(env.seen[0].url.searchParams.get("key"), KEY);
  // An asset fetch is not a navigation, so there is no cookie to issue — the
  // browser already sent this one, and it will send it again for the next chunk.
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("a document reload survives on the cookie alone, and renews it", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(
    new Request("https://relay.example.test/", {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: `other=1; kin_relay=${encodeURIComponent(ROOM)}|${encodeURIComponent(KEY)}; tail=2`,
      },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(env.seen[0].url.searchParams.get("room"), ROOM);
  // The one request that cannot carry the query is the one that pushes the
  // 30-day window forward, so a phone that is opened keeps its cookie.
  assert.match(response.headers.get("Set-Cookie") ?? "", /^kin_relay=/);
});

test("no query and no cookie is still a 400", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(new Request("https://relay.example.test/"), env);
  assert.equal(response.status, 400);
  assert.equal(env.seen.length, 0);
});

test("an unrelated or malformed cookie is not a credential", async () => {
  const env = recordingEnv();
  for (const cookie of ["session=abc", "kin_relay=nonsense", "kin_relay=|", "kin_relay="]) {
    const response = await worker.fetch(
      new Request("https://relay.example.test/", { headers: { Cookie: cookie } }),
      env,
    );
    assert.equal(response.status, 400, `${cookie} must not authorize a request`);
  }
  assert.equal(env.seen.length, 0);
});

test("an over-long room is refused even when it comes from a cookie", async () => {
  const env = recordingEnv();
  const response = await worker.fetch(
    new Request("https://relay.example.test/", {
      headers: { Cookie: credentialCookie("c".repeat(129), KEY) },
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(env.seen.length, 0);
});

test("a socket upgrade still reads its credential from the query alone", async () => {
  const env = recordingEnv();
  const withCookieOnly = await worker.fetch(
    new Request("https://relay.example.test/api/ws", {
      headers: { Cookie: credentialCookie(ROOM, KEY), Upgrade: "websocket" },
    }),
    env,
  );
  assert.equal(withCookieOnly.status, 400, "upgrades must not be rebuilt to inject a credential");
  assert.equal(env.seen.length, 0);

  const withQuery = await worker.fetch(
    new Request(`https://relay.example.test/api/ws?room=${ROOM}&key=${KEY}`, {
      headers: { Upgrade: "websocket", Accept: "*/*" },
    }),
    env,
  );
  assert.equal(withQuery.status, 200);
  // A 101 response carries the accepted socket; rebuilding it to append a
  // header would drop the socket, so an upgrade is never wrapped.
  assert.equal(withQuery.headers.get("Set-Cookie"), null);
  assert.equal(env.seen[0].url.searchParams.get("key"), KEY);
});

test("credential encoding survives a room or key that needs escaping", () => {
  const room = "room with spaces/and?punctuation";
  const key = "key+with=equals&amps";
  const parsed = decodeCredential(credentialCookie(room, key).split("=").slice(1).join("=").split(";")[0]);
  assert.deepEqual(parsed, { room, key });
  assert.equal(readCredentialCookie(new Request("https://x.test/", {
    headers: { Cookie: credentialCookie(room, key) },
  })).room, room);
});

// The room's own authorization, modelled: a request that does not carry the
// room's key is the room's 401 to give, not the worker's to pre-empt. Two
// findings below need the status to mean something, so this is the handler they
// run against rather than one that answers 200 to everything.
function keyedEnv() {
  return recordingEnv((request) =>
    new URL(request.url).searchParams.get("key") === KEY
      ? new Response("served", { status: 200 })
      : new Response('{"error":"unauthorized"}', { status: 401 }));
}

test("a room-only link is answered by the room it names, not the room in the cookie", async () => {
  const env = keyedEnv();
  const response = await worker.fetch(
    new Request("https://relay.example.test/?room=room-b", {
      headers: { Accept: "text/html", Cookie: credentialCookie(ROOM, KEY) },
    }),
    env,
  );

  // `relay.connect_url` is exactly this URL — the room without credentials. A
  // browser that also holds a cookie for another room must not be handed that
  // room's data under a link that names this one.
  assert.equal(env.seen.length, 1);
  assert.equal(env.seen[0].id, "room-id:room-b", "the named room is the room that gets asked");
  assert.equal(env.seen[0].url.searchParams.get("key"), null, "a link without a key must not be given one");
  // And the answer is the room's own 401, which is what this URL returned before
  // any cookie existed.
  assert.equal(response.status, 401);
});

test("a navigation the room refused does not overwrite a working cookie", async () => {
  const env = keyedEnv();
  const response = await worker.fetch(
    new Request(`https://relay.example.test/?room=${ROOM}&key=stale`, {
      headers: { Accept: "text/html", Cookie: credentialCookie(ROOM, KEY) },
    }),
    env,
  );

  assert.equal(response.status, 401);
  // Remembering the rejected key would strand the phone: every later reload
  // would arrive with it and be refused before the console could load and
  // recover from the credentials it still has.
  assert.equal(response.headers.get("Set-Cookie"), null);
});

test("a link that names only a key is refused, not answered from the cookie", async () => {
  const env = keyedEnv();
  const response = await worker.fetch(
    new Request("https://relay.example.test/?key=key-b", {
      headers: { Accept: "text/html", Cookie: credentialCookie(ROOM, KEY) },
    }),
    env,
  );

  // No room to route by, so there is no honest answer other than the one a
  // request with no room at all gets. Serving it from the cookie's room would
  // swap the credential the URL asked for without saying so.
  assert.equal(response.status, 400);
  assert.equal(env.seen.length, 0);
});

// Everything above stubs the room, which means nothing above proves that the
// credential the worker injects is one the room will actually accept — the two
// halves could agree on a shape that no real request produces. This walks the
// sequence a phone makes, against the real Durable Object, and lets the room's
// own `proxyHTTP` be the judge: a wrong or missing key comes back 401 from
// there, not from an assertion written to match the worker's output.
function liveEnv() {
  const stored = new Map([["relay-key", KEY]]);
  const room = new RelayRoom({
    storage: {
      async get(name) {
        return stored.get(name);
      },
      async put(name, value) {
        stored.set(name, value);
      },
    },
  });
  // A daemon is what makes proxyHTTP answer at all. The handshake that normally
  // installs one needs a WebSocketPair, which is a workerd global, so the socket
  // is seated directly and answers each request frame the way a daemon would.
  const daemon = {
    readyState: 1,
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.kind !== "request") return;
      queueMicrotask(() => room.onDaemonMessage(
        { data: JSON.stringify({ v: 2, kind: "response", data: { id: frame.data.id, status: 200 } }) },
        daemon,
      ));
    },
  };
  room.daemon = daemon;
  return {
    RELAY_ROOM: {
      idFromName: (name) => name,
      get: () => room,
    },
  };
}

test("a phone can reload and open a lazy chunk with nothing but the cookie", async () => {
  const env = liveEnv();
  const jar = new Map();

  const send = (path, { navigate = false } = {}) => {
    const headers = {};
    if (navigate) headers.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return worker.fetch(new Request(`https://relay.example.test${path}`, { headers }), env)
      .then((response) => {
        const set = response.headers.get("Set-Cookie");
        if (set) {
          const [pair] = set.split(";");
          const at = pair.indexOf("=");
          jar.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return response;
      });
  };

  // 1. The relay link is opened. This is the only request that ever carries the
  //    query; it is also the only one that can hand the browser a cookie.
  const opened = await send(`/inbox?room=${encodeURIComponent(ROOM)}&key=${encodeURIComponent(KEY)}`, {
    navigate: true,
  });
  assert.equal(opened.status, 200, "the relay link the product hands out must open");
  assert.ok(jar.has("kin_relay"), "opening the link must seat the credential");

  // 2. A reload. The console has stripped room and key from the address bar, so
  //    the cookie is all there is — and it has to be enough, because it is the
  //    same request that renews the 30-day window.
  const reloaded = await send("/", { navigate: true });
  assert.equal(reloaded.status, 200, "a reload must not be answered 401 or 400");
  assert.ok(reloaded.headers.get("Set-Cookie"), "a reload should renew the window");

  // 3. The lazy chunk behind the file preview. CodeViewer is the only `lazy()`
  //    in the console, and the URL a module loader derives for it is one no
  //    build-time rewrite can reach: the entry chunk names it with a static
  //    `import`, which the browser resolves by itself, dropping any query the
  //    document was served with.
  const chunk = await send("/assets/CodeViewer-DFFL7zmv.js");
  assert.equal(chunk.status, 200, "the lazily imported chunk must load through the relay");

  // 4. And the cookie is still not a blanket grant: without it, the same three
  //    requests are refused before the room is consulted.
  for (const path of ["/", "/assets/CodeViewer-DFFL7zmv.js"]) {
    const bare = await worker.fetch(new Request(`https://relay.example.test${path}`), env);
    assert.equal(bare.status, 400, `${path} must not be reachable without a credential`);
  }
});
