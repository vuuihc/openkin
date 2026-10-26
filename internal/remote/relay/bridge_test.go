package relay

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/vuuihc/openkin/web"
	"nhooyr.io/websocket"
)

func TestNewBridge(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "room", "http://127.0.0.1:7777")
	if b.room != "room" || b.localBase != "http://127.0.0.1:7777" || b.relayKey == "" {
		t.Fatalf("unexpected bridge: %+v", b)
	}
	if b.keepaliveEvery != keepaliveInterval || b.healthyAfter != healthyGeneration {
		t.Fatalf("bridge defaults = %v/%v", b.keepaliveEvery, b.healthyAfter)
	}
}

// fakeRelay stands in for the Relay worker as Cloudflare fronts it: a socket
// that stays silent longer than idle is dropped, exactly as the edge drops an
// idle daemon leg (which detaches every client). hold closes the socket after a
// fixed time regardless of traffic, and accepted records when each generation
// began so the reconnect cadence can be measured.
type fakeRelay struct {
	idle time.Duration
	hold time.Duration

	mu       sync.Mutex
	kinds    []string
	accepted []time.Time
	srv      *httptest.Server
}

func newFakeRelay(t *testing.T, idle, hold time.Duration) *fakeRelay {
	t.Helper()
	f := &fakeRelay{idle: idle, hold: hold}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "done")
		f.mu.Lock()
		f.accepted = append(f.accepted, time.Now())
		f.mu.Unlock()

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		if f.hold > 0 {
			go func() {
				time.Sleep(f.hold)
				cancel()
				_ = c.CloseNow()
			}()
		}
		for {
			readCtx, cancelRead := context.WithTimeout(ctx, f.idle)
			_, msg, err := c.Read(readCtx)
			cancelRead()
			if err != nil {
				return
			}
			var frame envelope
			if json.Unmarshal(msg, &frame) != nil {
				continue
			}
			f.mu.Lock()
			f.kinds = append(f.kinds, frame.Kind)
			f.mu.Unlock()
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRelay) snapshot() (kinds []string, accepted []time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.kinds...), append([]time.Time(nil), f.accepted...)
}

func (f *fakeRelay) count(kind string) int {
	kinds, _ := f.snapshot()
	n := 0
	for _, k := range kinds {
		if k == kind {
			n++
		}
	}
	return n
}

// A daemon that lets the relay socket go idle loses every connected client to a
// "daemon offline" close and cannot be reached over HTTP until it reconnects, so
// the app shows a reconnect banner for a daemon that never went down. The
// bridge must keep the leg warm on its own.
func TestBridgeKeepsIdleRelayConnectionAlive(t *testing.T) {
	const idle = 250 * time.Millisecond
	f := newFakeRelay(t, idle, 0)

	b := NewBridge(f.srv.URL, "room-1", "http://127.0.0.1:7777")
	b.keepaliveEvery = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = b.Run(ctx) }()

	time.Sleep(5 * idle)

	kinds, accepted := f.snapshot()
	if len(accepted) != 1 {
		t.Fatalf("generations = %d, want 1: the relay socket went idle and was closed", len(accepted))
	}
	if len(kinds) == 0 {
		t.Fatal("no frames recorded: the fake relay never saw the hello")
	}
	if kinds[0] != "hello" {
		t.Fatalf("first frame = %q, want hello", kinds[0])
	}
	if pings := f.count("ping"); pings < 4 {
		t.Fatalf("keepalive frames = %d, want at least 4 in %v", pings, 5*idle)
	}
	if !b.Connected() {
		t.Fatal("bridge reports disconnected while the generation is alive")
	}
}

// Backoff exists for a relay that refuses connections, not for one that
// accepted a healthy generation and then closed it. Without a reset, each
// relay-side close doubles the wait toward the 15s cap and every client stays
// offline for that long.
func TestBridgeResetsBackoffAfterHealthyGeneration(t *testing.T) {
	const (
		hold   = 120 * time.Millisecond
		cycles = 4
	)
	f := newFakeRelay(t, time.Second, hold)

	b := NewBridge(f.srv.URL, "room-1", "http://127.0.0.1:7777")
	b.keepaliveEvery = 20 * time.Millisecond
	b.healthyAfter = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = b.Run(ctx) }()

	deadline := time.Now().Add(time.Duration(cycles) * (hold + minReconnectDelay + 250*time.Millisecond))
	for {
		if _, accepted := f.snapshot(); len(accepted) > cycles {
			break
		}
		if time.Now().After(deadline) {
			_, accepted := f.snapshot()
			t.Fatalf("generations = %d, want more than %d", len(accepted), cycles)
		}
		time.Sleep(20 * time.Millisecond)
	}

	_, accepted := f.snapshot()
	for i := 1; i < len(accepted); i++ {
		if gap := accepted[i].Sub(accepted[i-1]); gap > 900*time.Millisecond {
			t.Fatalf("reconnect gap %d = %v after a %v generation; backoff did not reset", i, gap, hold)
		}
	}
}

func TestPersistentBridgeCredentials(t *testing.T) {
	dir := t.TempDir()
	first, err := NewPersistentBridge("wss://relay.example.com", dir, "http://127.0.0.1:7777")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewPersistentBridge("wss://relay.example.com", dir, "http://127.0.0.1:7777")
	if err != nil {
		t.Fatal(err)
	}
	if first.room != second.room || first.relayKey != second.relayKey {
		t.Fatal("relay credentials did not persist")
	}
	info, err := os.Stat(filepath.Join(dir, "relay", "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", info.Mode().Perm())
	}
}

func TestConnectURLs(t *testing.T) {
	b := NewBridge("wss://relay.example.com/path", "room-1", "http://127.0.0.1:7777")
	if got := b.ConnectURL(); got != "https://relay.example.com/path?room=room-1" {
		t.Fatalf("ConnectURL = %q", got)
	}
	if !strings.Contains(b.ConnectURLWithKey(), "key=") {
		t.Fatal("ConnectURLWithKey omitted relay key")
	}
	ws, err := url.Parse(b.wsURL())
	if err != nil {
		t.Fatal(err)
	}
	if ws.Query().Get("key") != b.relayKey || ws.Query().Get("role") != "daemon" {
		t.Fatalf("daemon WebSocket URL omitted credentials: %s", ws)
	}
}

func TestMalformedRelayURLRejected(t *testing.T) {
	b := NewBridge("ftp://relay.example.com", "room", "http://127.0.0.1:7777")
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := b.Run(ctx); err == nil {
		t.Fatal("Run accepted malformed relay URL")
	}
}

// The relay hands response bodies to the client as-is, so a compressed body that
// is not labelled as compressed arrives as unparseable bytes. A real client
// (URLSession, browsers) sends Accept-Encoding, which is only safe if the local
// read is decompressed first.
func TestRelayedRequestReadsDecompressedBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write([]byte(`{"ok":true}`))
		if err := gz.Close(); err != nil {
			t.Errorf("gzip close: %v", err)
		}
	}))
	defer srv.Close()

	req, err := newLocalRequest(context.Background(), srv.URL, requestData{
		Method:  http.MethodGet,
		Path:    "/api/pairing/exchange",
		Headers: map[string]string{"Accept-Encoding": "gzip, deflate, br"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"ok":true}` {
		t.Fatalf("relayed body = %q, want plain JSON", body)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want it consumed by the transport", got)
	}
}

// Mirrors the daemon's real response stack (internal/api/api.go wires
// middleware.Compress(5)) instead of a hand-rolled gzip handler, and pins the
// property the relay depends on: bodies as small as the pairing reply are
// compressed too, so no JSON endpoint is exempt from the Accept-Encoding rule.
func TestRelayedRequestDecompressesRealAPIMiddleware(t *testing.T) {
	const payload = `{"device_id":"d","token":"t","label":"Kin"}`

	r := chi.NewRouter()
	r.Use(middleware.Compress(5))
	r.Get("/api/pairing/exchange", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(payload))
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Control: a request that does send Accept-Encoding really is compressed, so
	// the assertions below cannot pass vacuously.
	direct, err := http.NewRequest(http.MethodGet, srv.URL+"/api/pairing/exchange", nil)
	if err != nil {
		t.Fatal(err)
	}
	direct.Header.Set("Accept-Encoding", "gzip")
	directResp, err := srv.Client().Do(direct)
	if err != nil {
		t.Fatal(err)
	}
	defer directResp.Body.Close()
	directBody, err := io.ReadAll(directResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got := directResp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("control: Content-Encoding = %q, want gzip", got)
	}
	if !bytes.HasPrefix(directBody, []byte{0x1f, 0x8b}) {
		t.Fatalf("control: middleware did not compress %d bytes: %q", len(payload), directBody)
	}

	req, err := newLocalRequest(context.Background(), srv.URL, requestData{
		Method:  http.MethodGet,
		Path:    "/api/pairing/exchange",
		Headers: map[string]string{"accept-encoding": "gzip, deflate, br"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != payload {
		t.Fatalf("relayed body = %q, want %q", body, payload)
	}
	if got := resp.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want it consumed by the transport", got)
	}
}

func TestNewLocalRequestKeepsAuthAndDropsHopHeaders(t *testing.T) {
	// Header names arrive lowercased: the relay worker iterates Fetch Headers.
	req, err := newLocalRequest(context.Background(), "http://127.0.0.1:7777", requestData{
		Method: http.MethodPost,
		Path:   "/api/tasks",
		Headers: map[string]string{
			"authorization":   "Bearer device-token",
			"content-type":    "application/json",
			"accept-encoding": "gzip",
			"connection":      "keep-alive",
			"content-length":  "2",
		},
	}, []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer device-token" {
		t.Fatalf("Authorization = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	for _, name := range []string{"Accept-Encoding", "Connection", "Content-Length"} {
		if got := req.Header.Get(name); got != "" {
			t.Fatalf("%s = %q, want it dropped", name, got)
		}
	}
}

// A browser sends no credentials for the subresources a document names, and the
// worker answers an uncredentialed request with 400 before it reaches the
// daemon. So the console, which is served through the relay to a phone, arrived
// as HTML and nothing else: every /assets/… request failed and the page stayed
// blank. The document has to name its assets the way the browser will ask for
// them.
func TestRelayResponseRewritesTheConsoleDocument(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "room-1", "http://127.0.0.1:7777")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("ETag", `"json-1"`)
			_, _ = w.Write([]byte(`{"path":"/assets/not-a-document.js"}`))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		// Both describe the bytes the daemon sent, which the rewrite changes.
		w.Header().Set("ETag", `"doc-1"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		_, _ = w.Write([]byte(`<script type="module" crossorigin src="/assets/index-abc.js"></script>`))
	}))
	defer srv.Close()

	resp, err := srv.Client().Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	headers, body, err := b.relayResponse(resp)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	want := `<script type="module" crossorigin src="/assets/index-abc.js?room=room-1&key=` + b.relayKey + `"></script>`
	if string(body) != want {
		t.Fatalf("relayed document = %q\nwant %q", body, want)
	}
	if headers["Content-Type"] != "text/html; charset=utf-8" || headers["Cache-Control"] != "no-cache" {
		t.Fatalf("headers = %v, want content type and cache policy kept", headers)
	}
	for _, name := range []string{"ETag", "Last-Modified"} {
		if _, ok := headers[name]; ok {
			t.Fatalf("%s survived a rewritten body: %v", name, headers)
		}
	}

	// Only the document is rewritten. JSON that happens to contain a path is
	// data, not a reference, and its validators still describe its bytes.
	resp, err = srv.Client().Get(srv.URL + "/api/thing")
	if err != nil {
		t.Fatal(err)
	}
	headers, body, err = b.relayResponse(resp)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"path":"/assets/not-a-document.js"}` {
		t.Fatalf("JSON body rewritten: %q", body)
	}
	if headers["ETag"] != `"json-1"` {
		t.Fatalf("ETag = %q, want it kept for an untouched body", headers["ETag"])
	}
}

// absoluteRefs returns every attribute value in a document that starts with a
// single slash: the requests a browser will make against the relay origin, and
// therefore the ones that need credentials.
//
// It scans bytes rather than reusing documentRef on purpose. A test whose oracle
// is the expression it is checking can only report that the expression agrees
// with itself.
func absoluteRefs(doc []byte) []string {
	var out []string
	for _, attr := range []string{"src", "href", "srcset", "poster", "data"} {
		for _, q := range []byte{'"', '\''} {
			needle := []byte(attr + "=" + string(q) + "/")
			for i := 0; ; {
				j := bytes.Index(doc[i:], needle)
				if j < 0 {
					break
				}
				start := i + j + len(needle) - 1
				stop := bytes.IndexByte(doc[start:], q)
				if stop < 0 {
					break
				}
				value := string(doc[start : start+stop])
				// "//host/path" is another origin, not a relay request.
				if !strings.HasPrefix(value, "//") {
					out = append(out, value)
				}
				i = start + stop
			}
		}
	}
	return out
}

// The shipped console is the document that has to survive this, and it has to
// survive it through the real response path — a rewrite the daemon never calls
// is the bug this whole change exists to fix. Reading the document from the
// embed rather than a fixture means a new root-absolute reference added to
// index.html — a font, an icon, a preload — fails here instead of on a phone.
func TestShippedConsoleHasNoReferenceTheRelayCannotRoute(t *testing.T) {
	sub, err := fs.Sub(web.FS, "dist")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		t.Fatal(err)
	}
	if len(absoluteRefs(doc)) == 0 {
		t.Fatal("index.html has no root-absolute references: this test would pass vacuously")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Mirrors uiHandler: the SPA shell is served as text/html and must
		// revalidate, which is what makes dropping the validators matter.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(doc)
	}))
	defer srv.Close()

	b := NewBridge("wss://relay.example.com", "room-1", "http://127.0.0.1:7777")
	resp, err := srv.Client().Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	_, body, err := b.relayResponse(resp)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}

	refs := absoluteRefs(body)
	before := absoluteRefs(doc)
	if len(refs) != len(before) {
		t.Fatalf("relayed document changed the number of references: %d -> %d", len(before), len(refs))
	}
	for i, value := range refs {
		routed, err := url.Parse(value)
		if err != nil {
			t.Fatalf("relayed reference %q is not a URL: %v", value, err)
		}
		query := routed.Query()
		if query.Get("room") == "" || query.Get("key") == "" {
			t.Fatalf("%q would reach the worker without credentials", value)
		}
		// Credentials have to land in the query. A substring check would accept
		// them inside a fragment, where the browser never sends them and the
		// subresource fails exactly as it did before the rewrite existed.
		original, err := url.Parse(before[i])
		if err != nil {
			t.Fatalf("original reference %q is not a URL: %v", before[i], err)
		}
		if routed.Path != original.Path || routed.Fragment != original.Fragment {
			t.Fatalf("relayed reference %q moved the path or fragment of %q", value, before[i])
		}
	}
}

// A fragment is opaque to the browser: "/icons/icon-512.png#v=2" is requested as
// "/icons/icon-512.png" with no query at all. Appending the credentials to the
// end of the attribute value therefore buried them where the worker never sees
// them, and that subresource failed exactly as it did before the rewrite
// existed — a fix that looked complete and changed nothing for the reference.
func TestRelayedDocumentKeepsCredentialsOutOfFragments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<link rel="icon" href="/icons/icon-512.png#v=2"><use href="/sprite.svg#icon"></use>`))
	}))
	defer srv.Close()

	b := NewBridge("wss://relay.example.com", "room-1", "http://127.0.0.1:7777")
	resp, err := srv.Client().Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	_, body, err := b.relayResponse(resp)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}

	query := "?room=room-1&key=" + b.relayKey
	want := `<link rel="icon" href="/icons/icon-512.png` + query + `#v=2">` +
		`<use href="/sprite.svg` + query + `#icon"></use>`
	if string(body) != want {
		t.Fatalf("relayed document = %q\nwant %q", body, want)
	}
}

// The rewrite reads the body as bytes looking for attribute values. If the
// Accept-Encoding strip in newLocalRequest ever broke, the body at that point
// would be gzip, which contains no `src="/…` at all: the rewrite would silently
// do nothing and the phone would get the same blank page, with no assertion
// failing anywhere. This pins the decompress-then-rewrite order that
// relayResponse's comment argues for, the way the JSON test above pins it for
// API bodies.
func TestRelayedDocumentIsDecompressedBeforeItIsRewritten(t *testing.T) {
	const doc = `<script type="module" crossorigin src="/assets/index-abc.js"></script>`

	r := chi.NewRouter()
	r.Use(middleware.Compress(5))
	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(doc))
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Control: the daemon really does compress a document this small, so the
	// assertion below cannot pass vacuously.
	direct, err := http.NewRequest(http.MethodGet, srv.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	direct.Header.Set("Accept-Encoding", "gzip")
	directResp, err := srv.Client().Do(direct)
	if err != nil {
		t.Fatal(err)
	}
	defer directResp.Body.Close()
	gzipped, err := io.ReadAll(directResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got := directResp.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("control: Content-Encoding = %q, want gzip", got)
	}
	if !bytes.HasPrefix(gzipped, []byte{0x1f, 0x8b}) {
		t.Fatalf("control: middleware did not compress the document: %q", gzipped)
	}

	b := NewBridge("wss://relay.example.com", "room-1", "http://127.0.0.1:7777")
	req, err := newLocalRequest(context.Background(), srv.URL, requestData{
		Method:  http.MethodGet,
		Path:    "/",
		Headers: map[string]string{"accept-encoding": "gzip, deflate, br"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, body, err := b.relayResponse(resp)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	want := `<script type="module" crossorigin src="/assets/index-abc.js?room=room-1&key=` + b.relayKey + `"></script>`
	if string(body) != want {
		t.Fatalf("relayed document = %q\nwant %q (rewrite saw compressed bytes?)", body, want)
	}
}

func TestRewriteDocumentLeavesWhatItCannotRoute(t *testing.T) {
	b := NewBridge("wss://relay.example.com", "room-1", "http://127.0.0.1:7777")
	query := "?room=room-1&key=" + b.relayKey
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{"script", `<script src="/assets/a.js"></script>`, `<script src="/assets/a.js` + query + `"></script>`},
		{"stylesheet", `<link rel="stylesheet" href="/assets/a.css">`, `<link rel="stylesheet" href="/assets/a.css` + query + `">`},
		{"existing query", `<link rel="manifest" href="/manifest.webmanifest?v=2">`, `<link rel="manifest" href="/manifest.webmanifest?v=2&room=room-1&key=` + b.relayKey + `">`},
		{"path with fragment", `<link rel="icon" href="/icons/icon-512.png#v=2">`, `<link rel="icon" href="/icons/icon-512.png` + query + `#v=2">`},
		{"path with query and fragment", `<link rel="icon" href="/icons/icon-512.png?v=2#frag">`, `<link rel="icon" href="/icons/icon-512.png?v=2&room=room-1&key=` + b.relayKey + `#frag">`},
		// Credentials after a "#" are never sent, so this value is not routed
		// however much it looks like it is.
		{"credentials in a fragment do not count", `<link rel="icon" href="/icons/icon-512.png#room=x&key=y">`, `<link rel="icon" href="/icons/icon-512.png` + query + `#room=x&key=y">`},
		// "monkey=" contains "key="; only a parsed query decides.
		{"lookalike substring", `<script src="/assets/monkey=1.js"></script>`, `<script src="/assets/monkey=1.js` + query + `"></script>`},
		{"already routed", `<script src="/assets/a.js` + query + `"></script>`, `<script src="/assets/a.js` + query + `"></script>`},
		{"other origin", `<script src="//cdn.example.com/a.js"></script>`, `<script src="//cdn.example.com/a.js"></script>`},
		{"absolute", `<a href="https://example.com/a">x</a>`, `<a href="https://example.com/a">x</a>`},
		{"fragment", `<a href="#top">x</a>`, `<a href="#top">x</a>`},
		{"relative", `<a href="inbox">x</a>`, `<a href="inbox">x</a>`},
		// Not matched, and so still unreachable through the relay. Vite emits
		// double quotes, and the shipped-document test fails if that changes.
		{"single quoted is not matched", `<script src='/assets/a.js'></script>`, `<script src='/assets/a.js'></script>`},
		{"unquoted is not matched", `<script src=/assets/a.js></script>`, `<script src=/assets/a.js></script>`},
		{"no references", `<p>hello</p>`, `<p>hello</p>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(b.rewriteDocument([]byte(tc.in))); got != tc.want {
				t.Fatalf("rewriteDocument = %q\nwant %q", got, tc.want)
			}
		})
	}
}
