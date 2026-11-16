package api

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/store"
	"github.com/vuuihc/openkin/internal/workspace"
)

// rawPNG is a PNG signature and the start of its first chunk. It is what an
// image viewer needs and what a text reader cannot decode — the two halves of
// the reason `raw=1` exists.
var rawPNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

// insertRawGeneration records a live generation rooted where its files are, the
// way a task with an isolated workspace has one.
func insertRawGeneration(t *testing.T, s *Server, taskID, root string, edit func(*store.WorkspaceGeneration)) store.WorkspaceGeneration {
	t.Helper()
	now := store.NowMilli()
	ws := store.WorkspaceGeneration{
		ID: taskID + ":g1", TaskID: taskID, Generation: 1,
		State: store.WorkspaceActive, SourceRoot: root, Scope: ".",
		PhysicalRoot: root, ExecutionCwd: root,
		CreatedAt: now, UpdatedAt: now,
	}
	if edit != nil {
		edit(&ws)
	}
	if _, err := s.Store.InsertWorkspaceAsCurrent(context.Background(), ws); err != nil {
		t.Fatal(err)
	}
	return ws
}

func rawGet(t *testing.T, h http.Handler, token, url string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// leaksNothing asserts the answer is a refusal, not the bytes it refused to
// read: a status alone would pass on a body that carried the file.
func leaksNothing(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if strings.Contains(rec.Body.String(), "LEAKED-CONTENT") {
		t.Fatalf("refusal carried the file: %s", rec.Body.String())
	}
}

func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return strings.TrimSpace(string(out))
}

// A preview of an image is a request for bytes, and the bytes are what comes
// back — not JSON with a string in it, which cannot hold a PNG.
func TestWorkspaceFileRawServesAnImageTheTextViewerRefuses(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteBytes(t, filepath.Join(root, "shot.png"), rawPNG)
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)
	url := "/api/tasks/" + taskID + "/workspaces/" + ws.ID + "/file?path=shot.png"

	// The plain read is what the panel does today, and it refuses the file. That
	// refusal is why the preview asks for the bytes instead.
	if rec := rawGet(t, s.Handler(), token, url); rec.Code != http.StatusBadRequest {
		t.Fatalf("text read: %d %s", rec.Code, rec.Body.String())
	}

	rec := rawGet(t, s.Handler(), token, url+"&raw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("raw read: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), rawPNG) {
		t.Fatalf("body = %q, want the file's bytes", rec.Body.Bytes())
	}
	want := map[string]string{
		"Content-Type":           "image/png",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "no-store",
		"Content-Length":         strconv.Itoa(len(rawPNG)),
		// Inline is what lets an <img> draw it without a download step.
		"Content-Disposition": "inline; filename=shot.png",
	}
	for header, value := range want {
		if got := rec.Header().Get(header); got != value {
			t.Errorf("%s = %q, want %q", header, got, value)
		}
	}
}

// Everything that is not an image type the viewer draws is a download. SVG is
// text: the code viewer already shows it, and a document that can carry script
// must not be drawn on the daemon's origin.
func TestWorkspaceFileRawIsADownloadUnlessItIsADrawableImage(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	mustWriteBytes(t, filepath.Join(root, "dump.bin"), []byte{0x00, 0x01})
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)

	for _, name := range []string{"logo.svg", "dump.bin"} {
		t.Run(name, func(t *testing.T) {
			rec := rawGet(t, s.Handler(), token,
				"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path="+name+"&raw=1")
			if rec.Code != http.StatusOK {
				t.Fatalf("raw read: %d %s", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
				t.Errorf("Content-Type = %q, want application/octet-stream", got)
			}
			if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename="+name {
				t.Errorf("Content-Disposition = %q, want an attachment", got)
			}
		})
	}
}

// rawFileType is the whole safety decision, so it is pinned by name: the type
// comes from the extension and nothing else, and only the listed image types
// may be drawn in place.
func TestRawFileTypeDrawsOnlyTheImagesItKnows(t *testing.T) {
	tests := []struct {
		name       string
		wantType   string
		wantInline bool
	}{
		{"shot.png", "image/png", true},
		{"SHOT.PNG", "image/png", true},
		{"photo.jpeg", "image/jpeg", true},
		{"photo.jpg", "image/jpeg", true},
		{"anim.gif", "image/gif", true},
		{"shot.webp", "image/webp", true},
		{"shot.bmp", "image/bmp", true},
		{"favicon.ico", "image/x-icon", true},
		{"shot.avif", "image/avif", true},
		{"report.pdf", "application/pdf", false},
		{"logo.svg", "application/octet-stream", false},
		{"page.html", "application/octet-stream", false},
		{"notes.txt", "application/octet-stream", false},
		{"Makefile", "application/octet-stream", false},
		{"archive.tar.gz", "application/octet-stream", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotType, gotInline := rawFileType(tc.name)
			if gotType != tc.wantType || gotInline != tc.wantInline {
				t.Fatalf("rawFileType(%q) = %q, %v; want %q, %v",
					tc.name, gotType, gotInline, tc.wantType, tc.wantInline)
			}
		})
	}
}

// The raw path widens what may be read, not where it may be read from: an
// oversized file and a path outside the workspace are refused exactly as the
// text read refuses them.
func TestWorkspaceFileRawKeepsTheCapsAndTheBounds(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	// The root sits inside a directory that also holds the file the traversal
	// and the symlink point at, so a naive join would find it.
	base := t.TempDir()
	root := filepath.Join(base, "ws")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	mustWriteBytes(t, filepath.Join(root, "huge.png"), make([]byte, 4*1024*1024+1))
	mustWriteBytes(t, filepath.Join(root, "shot.png"), rawPNG)
	// A file exactly at the cap is inside it: the limit is `> limit`, not `>=`.
	mustWriteBytes(t, filepath.Join(root, "atcap.png"), make([]byte, 4*1024*1024))
	mustWriteBytes(t, filepath.Join(base, "leak.png"), []byte("LEAKED-CONTENT"))
	if err := os.Symlink(filepath.Join(base, "leak.png"), filepath.Join(root, "escape.png")); err != nil {
		t.Fatal(err)
	}
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)

	tests := []struct {
		name   string
		path   string
		status int
		check  func(t *testing.T, rec *httptest.ResponseRecorder)
	}{
		{
			name:   "oversized",
			path:   "huge.png",
			status: http.StatusBadRequest,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				if !strings.Contains(rec.Body.String(), "file exceeds") {
					t.Fatalf("body = %s", rec.Body.String())
				}
			},
		},
		{
			name:   "traversal",
			path:   "../leak.png",
			status: http.StatusBadRequest,
			check:  leaksNothing,
		},
		{
			name:   "escaping symlink",
			path:   "escape.png",
			status: http.StatusBadRequest,
			check:  leaksNothing,
		},
		{
			name:   "exactly at the cap",
			path:   "atcap.png",
			status: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				if rec.Body.Len() != 4*1024*1024 {
					t.Fatalf("body = %d bytes, want the whole file", rec.Body.Len())
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := rawGet(t, s.Handler(), token,
				"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path="+tc.path+"&raw=1")
			if rec.Code != tc.status {
				t.Fatalf("status = %d %s, want %d", rec.Code, rec.Body.String(), tc.status)
			}
			tc.check(t, rec)
		})
	}
}

// A download is not a preview. The preview cap keeps a mislabeled archive out
// of the daemon's memory, and holding a download to it would refuse the very
// file the person asked to save — so the download streams from disk.
func TestWorkspaceFileDownloadStreamsPastThePreviewCap(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	big := bytes.Repeat([]byte{0x1a}, 4*1024*1024+1)
	mustWriteBytes(t, filepath.Join(root, "talk.mp4"), big)
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)
	base := "/api/tasks/" + taskID + "/workspaces/" + ws.ID + "/file?path=talk.mp4"

	if rec := rawGet(t, s.Handler(), token, base+"&raw=1"); rec.Code != http.StatusBadRequest {
		t.Fatalf("preview of an oversized file: %d %s", rec.Code, rec.Body.String())
	}

	rec := rawGet(t, s.Handler(), token, base+"&download=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("download: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), big) {
		t.Fatalf("body = %d bytes, want every byte of the file", rec.Body.Len())
	}
	want := map[string]string{
		"Content-Type":           "application/octet-stream",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control":          "no-store",
		"Content-Length":         strconv.Itoa(len(big)),
		"Content-Disposition":    "attachment; filename=talk.mp4",
	}
	for header, value := range want {
		if got := rec.Header().Get(header); got != value {
			t.Errorf("%s = %q, want %q", header, got, value)
		}
	}
}

// Asking for the download of a file the preview would have drawn gives the
// same bytes with the other disposition — and a name that needs quoting comes
// back quoted rather than cut short.
func TestWorkspaceFileDownloadIsAnAttachmentEvenForAnImage(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteBytes(t, filepath.Join(root, "my shot.png"), rawPNG)
	taskID := insertWorkspaceTask(t, s.Store, root)
	ws := insertRawGeneration(t, s, taskID, root, nil)
	url := "/api/tasks/" + taskID + "/workspaces/" + ws.ID + "/file?path=my%20shot.png"

	preview := rawGet(t, s.Handler(), token, url+"&raw=1")
	if got := preview.Header().Get("Content-Disposition"); got != `inline; filename="my shot.png"` {
		t.Errorf("preview disposition = %q", got)
	}

	rec := rawGet(t, s.Handler(), token, url+"&download=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("download: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), rawPNG) {
		t.Fatalf("body = %q, want the file's bytes", rec.Body.Bytes())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="my shot.png"` {
		t.Errorf("download disposition = %q", got)
	}

	// Naming both flags is a download: the stronger disposition wins.
	both := rawGet(t, s.Handler(), token, url+"&raw=1&download=1")
	if got := both.Header().Get("Content-Disposition"); got != `attachment; filename="my shot.png"` {
		t.Errorf("raw+download disposition = %q", got)
	}

	// A quote in the name is escaped, not cut off at the quote.
	quoted := `say "hi".png`
	mustWriteBytes(t, filepath.Join(root, quoted), rawPNG)
	quotedRec := rawGet(t, s.Handler(), token,
		"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path="+neturl.QueryEscape(quoted)+"&download=1")
	if quotedRec.Code != http.StatusOK {
		t.Fatalf("quoted name download: %d %s", quotedRec.Code, quotedRec.Body.String())
	}
	if got := quotedRec.Header().Get("Content-Disposition"); got != `attachment; filename="say \"hi\".png"` {
		t.Errorf("quoted disposition = %q", got)
	}
}

// The source browser reads the checkout a task runs in. Its files are files
// too, and the same preview has to work there.
func TestSourceFileRawServesBytesFromTheSourceCheckout(t *testing.T) {
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	root := t.TempDir()
	mustWriteBytes(t, filepath.Join(root, "shot.png"), rawPNG)
	taskID := insertWorkspaceTask(t, s.Store, root)

	rec := rawGet(t, s.Handler(), token, "/api/tasks/"+taskID+"/source/file?path=shot.png&raw=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("source raw read: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), rawPNG) {
		t.Fatalf("body = %q, want the file's bytes", rec.Body.Bytes())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q", got)
	}

	// The download is the streaming path, with the same type and an attachment.
	dl := rawGet(t, s.Handler(), token, "/api/tasks/"+taskID+"/source/file?path=shot.png&download=1")
	if dl.Code != http.StatusOK {
		t.Fatalf("source download: %d %s", dl.Code, dl.Body.String())
	}
	if !bytes.Equal(dl.Body.Bytes(), rawPNG) {
		t.Fatalf("download body = %q, want the file's bytes", dl.Body.Bytes())
	}
	if got := dl.Header().Get("Content-Disposition"); got != "attachment; filename=shot.png" {
		t.Fatalf("Content-Disposition = %q, want an attachment", got)
	}
}

// Recorded sides are git trees, not directories. An image in a checked-in
// snapshot is read from the tree the same way a text file is.
func TestWorkspaceFileRawReadsAnImageFromASnapshotSide(t *testing.T) {
	requireGitBin(t)
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	repo := t.TempDir()
	initRepo(t, repo)
	mustWriteBytes(t, filepath.Join(repo, "shot.png"), rawPNG)
	gitRun(t, repo, "add", "shot.png")
	gitRun(t, repo, "commit", "-m", "add image")
	base := gitOutput(t, repo, "rev-parse", "HEAD")

	// The work changes the image, so the two sides hold different bytes: a raw
	// read that answered one tree for both would still look right on a fixture
	// where they are the same.
	editedPNG := append(append([]byte{}, rawPNG...), "\x00\x00\x00\x10IDAT"...)
	mustWriteBytes(t, filepath.Join(repo, "shot.png"), editedPNG)
	gitRun(t, repo, "add", "shot.png")
	gitRun(t, repo, "commit", "-m", "edit image")
	finalTree := gitOutput(t, repo, "rev-parse", "HEAD^{tree}")

	taskID := insertWorkspaceTask(t, s.Store, repo)
	ws := insertRawGeneration(t, s, taskID, repo, func(ws *store.WorkspaceGeneration) {
		ws.State = store.WorkspaceIntegrated
		ws.BaseOID = base
		ws.FinalTreeOID = finalTree
	})

	for side, want := range map[string][]byte{"base": rawPNG, "final": editedPNG} {
		t.Run(side, func(t *testing.T) {
			rec := rawGet(t, s.Handler(), token,
				"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path=shot.png&raw=1&side="+side)
			if rec.Code != http.StatusOK {
				t.Fatalf("raw %s read: %d %s", side, rec.Code, rec.Body.String())
			}
			if !bytes.Equal(rec.Body.Bytes(), want) {
				t.Fatalf("body = %q, want %q", rec.Body.Bytes(), want)
			}
			if got := rec.Header().Get("Content-Type"); got != "image/png" {
				t.Fatalf("Content-Type = %q", got)
			}
		})
	}

	// A snapshot comes out of git into memory, so its download keeps the
	// preview cap; the disposition still says download, even when raw is also
	// named — both flags together are a download.
	rec := rawGet(t, s.Handler(), token,
		"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path=shot.png&download=1&side=base")
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot download: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), rawPNG) {
		t.Fatalf("body = %q, want the base bytes", rec.Body.Bytes())
	}
	if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename=shot.png" {
		t.Fatalf("Content-Disposition = %q, want an attachment", got)
	}

	// Both flags are a download on every recorded side. A drawable image is
	// the fixture that can tell the two dispositions apart.
	for _, side := range []string{"base", "final"} {
		both := rawGet(t, s.Handler(), token,
			"/api/tasks/"+taskID+"/workspaces/"+ws.ID+"/file?path=shot.png&raw=1&download=1&side="+side)
		if got := both.Header().Get("Content-Disposition"); got != "attachment; filename=shot.png" {
			t.Fatalf("%s raw+download disposition = %q, want an attachment", side, got)
		}
	}
}

// A snapshot's download is still read out of git into memory, so the preview
// cap holds there even though the same file would stream from a live workspace.
func TestSnapshotDownloadKeepsThePreviewCap(t *testing.T) {
	requireGitBin(t)
	s, token := newTestServer(t)
	s.Workspace = workspace.NewManager(t.TempDir())
	repo := t.TempDir()
	initRepo(t, repo)
	atCap := bytes.Repeat([]byte{'a'}, 4*1024*1024)
	overCap := bytes.Repeat([]byte{'b'}, 4*1024*1024+1)
	mustWriteBytes(t, filepath.Join(repo, "atcap.mp4"), atCap)
	mustWriteBytes(t, filepath.Join(repo, "over.mp4"), overCap)
	gitRun(t, repo, "add", "atcap.mp4", "over.mp4")
	gitRun(t, repo, "commit", "-m", "add large files")
	finalTree := gitOutput(t, repo, "rev-parse", "HEAD^{tree}")

	taskID := insertWorkspaceTask(t, s.Store, repo)
	ws := insertRawGeneration(t, s, taskID, repo, func(ws *store.WorkspaceGeneration) {
		ws.State = store.WorkspaceIntegrated
		ws.FinalTreeOID = finalTree
	})
	fileURL := "/api/tasks/" + taskID + "/workspaces/" + ws.ID + "/file?side=final&download=1&path="

	// At the cap, the download is the bytes — not the text envelope the same
	// read without `download=1` would answer with.
	rec := rawGet(t, s.Handler(), token, fileURL+"atcap.mp4")
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot download: %d %s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), atCap) {
		t.Fatalf("body = %d bytes, want the whole file", rec.Body.Len())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/octet-stream" {
		t.Errorf("Content-Type = %q, want bytes", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != "attachment; filename=atcap.mp4" {
		t.Errorf("Content-Disposition = %q, want an attachment", got)
	}

	// Both flags on the final side are a download too, not an inline draw.

	over := rawGet(t, s.Handler(), token, fileURL+"over.mp4")
	if over.Code != http.StatusBadRequest {
		t.Fatalf("snapshot download over the cap: %d %s", over.Code, over.Body.String())
	}
	if !strings.Contains(over.Body.String(), "too large") {
		t.Fatalf("body = %s, want the git cap named", over.Body.String())
	}
}

// The bytes of a remote workspace live on the other machine, and the worker
// protocol carries text. Saying so is honest; forwarding the raw request would
// return whatever an older machine happened to do with it.
func TestRawPreviewOnARemoteWorkspaceSaysSoWithoutAskingTheMachine(t *testing.T) {
	work, here := twoCheckouts(t)
	write(t, work, "shot.png", string(rawPNG))

	s, h, master, deviceID := remoteWorkspaceHub(t, filepath.Dir(work))
	task := remoteTask(t, s, deviceID, here, anchoredAt(t, s, deviceID, work))

	rec := getTaskRoute(t, h, master, task.ID, "/source/file?path=shot.png&raw=1")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("raw read of a remote source: %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "remote") {
		t.Errorf("error = %s, want the remote workspace named", rec.Body.String())
	}

	if rec := getTaskRoute(t, h, master, task.ID, "/source/file?path=shot.png&download=1"); rec.Code != http.StatusNotImplemented {
		t.Errorf("download of a remote source: %d %s", rec.Code, rec.Body.String())
	}

	// The text read of the same file is still the machine's to answer.
	if rec := getTaskRoute(t, h, master, task.ID, "/source/file?path=shot.png"); rec.Code == http.StatusNotImplemented {
		t.Errorf("text read was refused as raw: %s", rec.Body.String())
	}
}
