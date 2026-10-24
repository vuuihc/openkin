package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vuuihc/openkin/internal/node"
	"github.com/vuuihc/openkin/internal/remote"
	"github.com/vuuihc/openkin/internal/store"
)

// machinesServer is newTestServer plus the machine-question plumbing: the
// registry of live connections, the table of questions waiting for answers, and
// this daemon's own filesystem, which it can answer about like any other
// machine.
func machinesServer(t *testing.T) (*Server, string, *node.Connections) {
	t.Helper()
	s, master := newTestServer(t)
	conns := node.NewConnections(nil)
	s.Nodes = conns
	s.Queries = node.NewQueries()
	// The composition root's router, with the two halves this test does not
	// exercise left out (internal/server/server.go). Using the real switch matters
	// more than it looks: it is a string switch on both sides of the wire, and a
	// test with its own copy of it would keep passing while the two drifted.
	s.NodeFrames = node.RouteFrame(nil, nil, s.Queries)
	return s, master, conns
}

// startResponder dials the Hub the way `kin serve --hub` does and answers
// questions about a machine whose working directories are the ones given.
func startResponder(t *testing.T, hubURL, deviceToken string, roots ...string) {
	t.Helper()
	runResponder(t, hubURL, deviceToken, &node.Responder{Roots: roots})
}

// runResponder is startResponder for a machine that needs more of itself
// configured than its roots — a checkout root, say, which is what makes it a
// machine a phone can start a session on rather than only browse.
func runResponder(t *testing.T, hubURL, deviceToken string, responder *node.Responder) {
	t.Helper()
	responder.Warn = func(format string, args ...any) { t.Logf("node: "+format, args...) }
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = node.Run(ctx, node.ClientConfig{
			HubURL:  hubURL,
			Token:   deviceToken,
			Hello:   testHello(),
			OnFrame: responder.Handle,
			OnReady: responder.SetSender,
			Warn:    func(format string, args ...any) { t.Logf("node: "+format, args...) },
		})
	}()
}

// treeOf builds a small directory tree for a machine to work in.
func treeOf(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, dir := range []string{"kin", "notes"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// getDirs asks one machine what is inside a directory.
func getDirs(t *testing.T, h http.Handler, token, device, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/machines/"+device+"/dirs?path="+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// TestMachineDirsAskTheOtherMachine is the phone's whole problem in one test:
// the console knows a machine by id, the directories are on that machine, and
// the answer comes back over the channel the machine dialled in on.
func TestMachineDirsAskTheOtherMachine(t *testing.T) {
	s, master, conns := machinesServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	root := treeOf(t)
	startResponder(t, hub.URL, deviceToken, root)
	awaitConnected(t, conns, deviceID)

	rec := getDirs(t, s.Handler(), deviceToken, deviceID, root)
	if rec.Code != http.StatusOK {
		t.Fatalf("dirs status %d: %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Path    string   `json:"path"`
		Parent  string   `json:"parent"`
		Roots   []string `json:"roots"`
		Entries []string `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Path != root {
		t.Fatalf("path = %q, want %q", listed.Path, root)
	}
	if got := strings.Join(listed.Entries, ","); got != "kin,notes" {
		t.Fatalf("entries = %q, want the machine's directories and no files", got)
	}
	if len(listed.Roots) != 1 || listed.Roots[0] != root {
		t.Fatalf("roots = %v, want what that machine declared", listed.Roots)
	}
}

// A Hub is a machine too. The same question about the daemon serving the
// console is answered here, by the same code, so the two cannot drift.
func TestMachineDirsOnThisMachineReadThisFilesystem(t *testing.T) {
	s, master, _ := machinesServer(t)
	root := treeOf(t)
	s.LocalMachine = &node.Responder{Roots: []string{root}}
	s.DesktopID = "desktop-1"

	for _, device := range []string{"self", "desktop-1"} {
		rec := getDirs(t, s.Handler(), master, device, root)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: dirs status %d: %s", device, rec.Code, rec.Body.String())
		}
		var listed struct {
			Entries []string `json:"entries"`
			Roots   []string `json:"roots"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
			t.Fatal(err)
		}
		if got := strings.Join(listed.Entries, ","); got != "kin,notes" {
			t.Fatalf("%s: entries = %q", device, got)
		}
	}
}

// The machine's own refusal is what the user reads: it is the party that knows
// where its boundary is, and a Hub that rephrased it would be guessing.
func TestMachineDirsCarryTheMachinesOwnRefusal(t *testing.T) {
	s, master, conns := machinesServer(t)
	hub := httptest.NewServer(s.Handler())
	defer hub.Close()
	deviceToken, deviceID := pairDevice(t, s.Handler(), master)
	root := treeOf(t)
	startResponder(t, hub.URL, deviceToken, root)
	awaitConnected(t, conns, deviceID)

	rec := getDirs(t, s.Handler(), deviceToken, deviceID, t.TempDir())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want the machine's refusal: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "works in") {
		t.Fatalf("the refusal lost the machine's own words: %s", rec.Body.String())
	}
}

// Offline is a normal state, not a failure: the answer is a sentence the phone
// can show, and it arrives now rather than after a timeout.
func TestMachineDirsRefuseAnOfflineMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	token, deviceID := pairDevice(t, s.Handler(), master)

	started := time.Now()
	rec := getDirs(t, s.Handler(), token, deviceID, t.TempDir())
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d, want a conflict: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "not connected") {
		t.Fatalf("the sentence does not say the machine is away: %s", rec.Body.String())
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("an offline machine took %s to answer", elapsed)
	}
}

// A question naming a machine this Hub does not know, or one that was revoked,
// is refused the same way a task naming it would be.
func TestMachineDirsRefuseAnUnknownMachine(t *testing.T) {
	s, master, _ := machinesServer(t)
	rec := getDirs(t, s.Handler(), master, "device-nobody", t.TempDir())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "unknown device") {
		t.Fatalf("the refusal does not name the problem: %s", rec.Body.String())
	}
}

// A relative path is not a question the Hub may ask: it would resolve against
// whatever directory that daemon was started in, which is not the Hub's choice.
func TestMachineDirsRefuseARelativePath(t *testing.T) {
	s, master, _ := machinesServer(t)
	rec := getDirs(t, s.Handler(), master, "self", "code/kin")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want a refusal: %s", rec.Code, rec.Body.String())
	}
}

// The machine list is the holder's: a guest account on someone's Hub has no
// business reading the holder's directory names.
func TestMachineDirsAreNotForGuests(t *testing.T) {
	s, _, _ := machinesServer(t)
	guestSession(t, s)
	req := httptest.NewRequest(http.MethodGet, "/api/machines/self/dirs", nil)
	req.AddCookie(guestCookie())
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want forbidden: %s", rec.Code, rec.Body.String())
	}
}

// guestSessionToken is the session cookie guestSession answers to.
const guestSessionToken = "guest-session"

// guestSession makes the server read one session cookie as a member account: an
// account on somebody else's Hub, which runs its own tasks and is not the party
// that holds this machine.
func guestSession(t *testing.T, s *Server) {
	t.Helper()
	s.Auth.SetSessionLookup(func(_ context.Context, token string) (remote.Principal, bool) {
		if token != guestSessionToken {
			return remote.Principal{}, false
		}
		return remote.Principal{Kind: remote.PrincipalUser, UserID: "user-2", Role: store.RoleMember}, true
	})
}

// guestCookie is that session as a request would carry it.
func guestCookie() *http.Cookie {
	return &http.Cookie{Name: remote.SessionCookieName, Value: guestSessionToken}
}

// awaitConnected waits for the Hub to have a live channel to the machine.
func awaitConnected(t *testing.T, conns *node.Connections, deviceID string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if conns.Connected(deviceID) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the machine never connected to the hub")
}
