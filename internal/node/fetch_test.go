package node

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/vuuihc/openkin/internal/attach"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// uploadServer is the Hub's upload route as a Node meets it: one bearer-gated
// GET per stored name.
type uploadServer struct {
	*httptest.Server
	mu     sync.Mutex
	files  map[string][]byte
	hits   int
	token  string
	prefix string
	// chunked drops Content-Length, so a client cannot refuse a file before
	// reading it. It is how a proxy in front of the Hub may serve one.
	chunked bool
}

func newUploadServer(t *testing.T, token string) *uploadServer {
	t.Helper()
	up := &uploadServer{files: map[string][]byte{}, token: token}
	up.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.mu.Lock()
		up.hits++
		up.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, up.prefix)
		name, ok := strings.CutPrefix(path, "/api/uploads/")
		if !ok {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+up.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		up.mu.Lock()
		data, found := up.files[name]
		chunked := up.chunked
		up.mu.Unlock()
		if !found {
			http.NotFound(w, r)
			return
		}
		if chunked {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(up.Close)
	return up
}

func (up *uploadServer) put(name string, data []byte) {
	up.mu.Lock()
	defer up.mu.Unlock()
	up.files[name] = data
}

func (up *uploadServer) requests() int {
	up.mu.Lock()
	defer up.mu.Unlock()
	return up.hits
}

func newFetcher(t *testing.T, up *uploadServer, opts ...func(*AttachmentFetcher)) *AttachmentFetcher {
	t.Helper()
	f, err := NewAttachmentFetcher(up.URL+up.prefix, up.token, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, opt := range opts {
		opt(f)
	}
	return f
}

func imagePrompt(path string) string {
	return "what is this?\n\nAttached image:\n- shot.png: " + path
}

func TestFetcherBringsTheFileAndRewritesThePrompt(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("png-bytes"))
	f := newFetcher(t, up)

	hubPath := "/state/uploads/ab12.png"
	prompt := f.Rewrite(context.Background(), "01J8ZQ6Q2K7YV0J9W1X2Y3Z4AB", imagePrompt(hubPath), []worker.Attachment{
		{Path: hubPath, Stored: "ab12.png"},
	})

	local := filepath.Join(f.dir, "01J8ZQ6Q2K7YV0J9W1X2Y3Z4AB", "ab12.png")
	if !strings.Contains(prompt, local) {
		t.Fatalf("prompt does not name the local copy: %q", prompt)
	}
	if strings.Contains(prompt, hubPath) {
		t.Fatalf("prompt still names the hub's path: %q", prompt)
	}
	data, err := os.ReadFile(local)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "png-bytes" {
		t.Fatalf("stored bytes = %q", data)
	}
}

func TestFetcherUsesTheSameCredentialTheNodeDialsWith(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("x"))
	f := newFetcher(t, up)
	if got := f.Rewrite(context.Background(), "task-1", imagePrompt("/hub/ab12.png"), []worker.Attachment{
		{Path: "/hub/ab12.png", Stored: "ab12.png"},
	}); strings.Contains(got, "(not transferred") {
		t.Fatalf("the fetch was refused: %q", got)
	}

	// And a wrong credential is a failure, not a silent empty file.
	bad := newFetcher(t, up)
	bad.token = "someone-elses"
	got := bad.Rewrite(context.Background(), "task-1", imagePrompt("/hub/ab12.png"), []worker.Attachment{
		{Path: "/hub/ab12.png", Stored: "ab12.png"},
	})
	if !strings.Contains(got, "(not transferred to this computer: the hub answered 401 Unauthorized") {
		t.Fatalf("refusal = %q", got)
	}
}

func TestFetcherKeepsTheHubsPathPrefix(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.prefix = "/kin"
	up.put("ab12.png", []byte("x"))
	f := newFetcher(t, up)

	got := f.Rewrite(context.Background(), "task-1", imagePrompt("/hub/ab12.png"), []worker.Attachment{
		{Path: "/hub/ab12.png", Stored: "ab12.png"},
	})
	if strings.Contains(got, "(not transferred") {
		t.Fatalf("a hub mounted under a prefix was not reached: %q", got)
	}
}

func TestFetcherNotesWhatItCouldNotBring(t *testing.T) {
	up := newUploadServer(t, "device-token")
	f := newFetcher(t, up)

	hubPath := "/state/uploads/gone.png"
	prompt := f.Rewrite(context.Background(), "task-1", imagePrompt(hubPath), []worker.Attachment{
		{Path: hubPath, Stored: "gone.png"},
	})
	if strings.Contains(prompt, hubPath) {
		t.Fatalf("the agent was left looking for the hub's path: %q", prompt)
	}
	if !strings.Contains(prompt, "- shot.png: (not transferred to this computer: the hub answered 404 Not Found") {
		t.Fatalf("prompt = %q", prompt)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "task-1", "gone.png")); !os.IsNotExist(err) {
		t.Fatalf("a failed fetch left a file: %v", err)
	}
}

// TestAFailureNoteIsNotMistakenForAnAttachment keeps the note readable by the
// reader that matters. The note stands where a path would, so the block parser
// must not take it for one: a model told a file called "EOF)" exists is bad
// enough, and the line would also be peeled off with the block, so the real
// reason would never reach it at all.
func TestAFailureNoteIsNotMistakenForAnAttachment(t *testing.T) {
	for _, reason := range []string{"EOF", "timeout", "404", "the hub answered 404 Not Found", ""} {
		note := notTransferred(reason)
		text, entries := attach.Split("look\n\nAttached image:\n- shot.png: " + note)
		if len(entries) != 0 {
			t.Fatalf("reason %q was read as an attachment: %#v", reason, entries)
		}
		if !strings.Contains(text, note) {
			t.Fatalf("reason %q did not reach the text: %q", reason, text)
		}
	}
	// And a reason too long for the note is shortened between characters, not
	// through one.
	long := notTransferred(strings.Repeat("图", 300))
	if !utf8.ValidString(long) {
		t.Fatalf("a long reason was cut mid-character: %q", long)
	}
}

func TestFetcherRefusesWhatIsNotOneSafeName(t *testing.T) {
	up := newUploadServer(t, "device-token")
	// A hostile Hub can serve a name with a separator in it; the check is on
	// this side, so the file being offered is what proves it. The refusal has to
	// name the reason: a name that climbs out is refused before anything is
	// created, not after a temp-file pattern happens to reject it.
	up.put("../../kin.db", []byte("evil"))
	f := newFetcher(t, up)
	hubPath := "/state/uploads/../../kin.db"
	got := f.Rewrite(context.Background(), "task-1", imagePrompt(hubPath), []worker.Attachment{
		{Path: hubPath, Stored: "../../kin.db"},
	})
	want := `(not transferred to this computer: the hub named it "../../kin.db", which is not a single safe path element`
	if !strings.Contains(got, want) {
		t.Fatalf("prompt = %q, want the name refused for being a name", got)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "kin.db")); !os.IsNotExist(err) {
		t.Fatalf("something was written outside the task directory: %v", err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(f.dir), "kin.db")); !os.IsNotExist(err) {
		t.Fatalf("something was written outside the attachment directory: %v", err)
	}
}

func TestFetcherRefusesATaskIDThatIsNotADirectoryName(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("x"))
	f := newFetcher(t, up)
	hubPath := "/hub/ab12.png"
	got := f.Rewrite(context.Background(), "../../elsewhere", imagePrompt(hubPath), []worker.Attachment{
		{Path: hubPath, Stored: "ab12.png"},
	})
	if !strings.Contains(got, "(not transferred to this computer: the task id is not safe to store files under") {
		t.Fatalf("prompt = %q", got)
	}
	if up.requests() != 0 {
		t.Fatalf("the hub was asked %d times for a task that cannot store anything", up.requests())
	}
}

func TestFetcherReusesACopyItAlreadyHas(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("x"))
	f := newFetcher(t, up)
	hubPath := "/hub/ab12.png"
	attachment := []worker.Attachment{{Path: hubPath, Stored: "ab12.png"}}

	f.Rewrite(context.Background(), "task-1", imagePrompt(hubPath), attachment)
	f.Rewrite(context.Background(), "task-1", imagePrompt(hubPath), attachment)
	if up.requests() != 1 {
		t.Fatalf("the hub was asked %d times for one file", up.requests())
	}
}

func TestFetcherBoundsOneFile(t *testing.T) {
	// Twice: once with a length the client can refuse before reading, once
	// without — the second is the only case that exercises the copy bound.
	for _, chunked := range []bool{false, true} {
		name := "with a length"
		if chunked {
			name = "streamed"
		}
		t.Run(name, func(t *testing.T) {
			up := newUploadServer(t, "device-token")
			up.put("ab12.png", []byte("ninebytes"))
			up.chunked = chunked
			f := newFetcher(t, up, func(f *AttachmentFetcher) { f.MaxFile = 8 })
			hubPath := "/hub/ab12.png"
			got := f.Rewrite(context.Background(), "task-1", imagePrompt(hubPath), []worker.Attachment{
				{Path: hubPath, Stored: "ab12.png"},
			})
			if !strings.Contains(got, "over the 8 this machine will take for one file") {
				t.Fatalf("prompt = %q", got)
			}
			if _, err := os.Stat(filepath.Join(f.dir, "task-1", "ab12.png")); !os.IsNotExist(err) {
				t.Fatalf("an oversize file was kept: %v", err)
			}
		})
	}
}

func TestFetcherBoundsTheTurn(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("aa11.png", []byte("123456"))
	up.put("bb22.png", []byte("123456"))
	f := newFetcher(t, up, func(f *AttachmentFetcher) { f.MaxTotal = 10 })
	prompt := "two\n\nAttached files:\n- one.png: /hub/aa11.png\n- two.png: /hub/bb22.png"
	got := f.Rewrite(context.Background(), "task-1", prompt, []worker.Attachment{
		{Path: "/hub/aa11.png", Stored: "aa11.png"},
		{Path: "/hub/bb22.png", Stored: "bb22.png"},
	})
	if !strings.Contains(got, filepath.Join(f.dir, "task-1", "aa11.png")) {
		t.Fatalf("the first file did not arrive: %q", got)
	}
	if !strings.Contains(got, "the rest of this turn's attachment budget is 4 bytes and it is 6") {
		t.Fatalf("the second file was not refused against the turn's budget: %q", got)
	}
}

func TestFetcherSweepsTaskDirectoriesNobodyUses(t *testing.T) {
	up := newUploadServer(t, "device-token")
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	f := newFetcher(t, up, func(f *AttachmentFetcher) {
		f.Now = func() time.Time { return now }
		f.Keep = 24 * time.Hour
	})
	old := filepath.Join(f.dir, "old-task")
	fresh := filepath.Join(f.dir, "fresh-task")
	for _, dir := range []string{old, fresh} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	oldTime := now.Add(-48 * time.Hour)
	if err := os.Chtimes(old, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	f.Sweep()

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("an unused task directory survived: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a task directory in use was removed: %v", err)
	}
}

func TestFetcherMarksATaskDirectoryUsed(t *testing.T) {
	up := newUploadServer(t, "device-token")
	up.put("ab12.png", []byte("x"))
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	f := newFetcher(t, up, func(f *AttachmentFetcher) { f.Now = func() time.Time { return now } })
	f.Rewrite(context.Background(), "task-1", imagePrompt("/hub/ab12.png"), []worker.Attachment{
		{Path: "/hub/ab12.png", Stored: "ab12.png"},
	})
	info, err := os.Stat(filepath.Join(f.dir, "task-1"))
	if err != nil {
		t.Fatal(err)
	}
	if info.ModTime().Sub(now) > time.Second || now.Sub(info.ModTime()) > time.Second {
		t.Fatalf("the task directory was not marked used: %v", info.ModTime())
	}
}

func TestAttachmentFetcherNeedsAUsableHubURL(t *testing.T) {
	for _, hub := range []string{"", "ftp://hub", "https://"} {
		if _, err := NewAttachmentFetcher(hub, "t", t.TempDir()); err == nil {
			t.Fatalf("NewAttachmentFetcher(%q) was accepted", hub)
		}
	}
	if _, err := NewAttachmentFetcher("https://kin.example.com", "t", ""); err == nil {
		t.Fatal("a fetcher with nowhere to write was accepted")
	}
	// ws is what the dial accepts; the fetch maps it rather than refusing it.
	f, err := NewAttachmentFetcher("wss://kin.example.com/prefix/", "t", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if f.base != "https://kin.example.com/prefix" {
		t.Fatalf("base = %q", f.base)
	}
}
