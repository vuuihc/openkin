package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/openkin/internal/remote/worker"
)

// uploadsFor lays out a Hub uploads directory the way the route does: one
// `<id><ext>` file per upload, flat.
func uploadsFor(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("bytes"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func block(entries ...[2]string) string {
	var b strings.Builder
	b.WriteString("please compare\n\nAttached files:\n")
	for _, entry := range entries {
		b.WriteString("- " + entry[0] + ": " + entry[1] + "\n")
	}
	return b.String()
}

func TestHubAttachmentsNamesOnlyTheFilesThisHubHas(t *testing.T) {
	dir := uploadsFor(t, "ab12.png", "cd34.md")
	// A file that looks like an upload but is not in the directory.
	outside := filepath.Join(t.TempDir(), "ef56.png")
	if err := os.WriteFile(outside, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A subdirectory holding a store: the uploads directory is flat, so a path
	// below it is not one this Hub wrote.
	nested := filepath.Join(dir, "nested")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(nested, "gh78.png")
	if err := os.WriteFile(inner, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	prompt := block(
		[2]string{"shot.png", filepath.Join(dir, "ab12.png")},
		[2]string{"notes.md", filepath.Join(dir, "cd34.md")},
		[2]string{"elsewhere.png", outside},
		[2]string{"inner.png", inner},
		[2]string{"typed.png", "/home/someone/Pictures/shot.png"},
	)
	got := hubAttachments(prompt, dir)
	if len(got) != 2 {
		t.Fatalf("attachments = %#v", got)
	}
	if got[0] != (worker.Attachment{Path: filepath.Join(dir, "ab12.png"), Stored: "ab12.png"}) {
		t.Fatalf("attachments[0] = %#v", got[0])
	}
	if got[1].Stored != "cd34.md" {
		t.Fatalf("attachments[1] = %#v", got[1])
	}
}

func TestHubAttachmentsKeepsThePathExactlyAsThePromptSaysIt(t *testing.T) {
	dir := uploadsFor(t, "ab12.png")
	// The rewrite replaces text, so the dispatch has to quote the text: a
	// cleaned-up variant the prompt does not contain would replace nothing.
	raw := dir + "/./ab12.png"
	got := hubAttachments(block([2]string{"shot.png", raw}), dir)
	if len(got) != 1 {
		t.Fatalf("attachments = %#v", got)
	}
	if got[0].Path != raw {
		t.Fatalf("path = %q, want the prompt's own text %q", got[0].Path, raw)
	}
}

func TestHubAttachmentsSkipsWhatIsNoLongerThere(t *testing.T) {
	dir := uploadsFor(t)
	prompt := block([2]string{"shot.png", filepath.Join(dir, "gone.png")})
	if got := hubAttachments(prompt, dir); len(got) != 0 {
		t.Fatalf("attachments = %#v", got)
	}
	// And a directory wearing an upload's name is not a file to ship.
	if err := os.MkdirAll(filepath.Join(dir, "d1r.png"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := hubAttachments(block([2]string{"x.png", filepath.Join(dir, "d1r.png")}), dir); len(got) != 0 {
		t.Fatalf("attachments = %#v", got)
	}
}

func TestHubAttachmentsWithoutAUploadsDirClaimsNothing(t *testing.T) {
	prompt := block([2]string{"shot.png", "/state/uploads/ab12.png"})
	if got := hubAttachments(prompt, ""); len(got) != 0 {
		t.Fatalf("attachments = %#v", got)
	}
	if got := hubAttachments("no attachments here", "/state/uploads"); len(got) != 0 {
		t.Fatalf("attachments = %#v", got)
	}
}

func TestHubAttachmentsStopsAtTheDispatchBound(t *testing.T) {
	names := make([]string, worker.MaxAttachments+3)
	entries := make([][2]string, 0, len(names))
	for i := range names {
		names[i] = strings.Repeat("a", 4) + string(rune('a'+i)) + ".png"
	}
	dir := uploadsFor(t, names...)
	for _, name := range names {
		entries = append(entries, [2]string{name, filepath.Join(dir, name)})
	}
	got := hubAttachments(block(entries...), dir)
	if len(got) != worker.MaxAttachments {
		t.Fatalf("attachments = %d, want %d", len(got), worker.MaxAttachments)
	}
	if err := (&worker.Dispatch{
		TurnID: "t", TaskID: "task-1", Agent: "a",
		Prompt:      block(entries...),
		Attachments: got,
	}).Validate(); err != nil {
		t.Fatalf("the dispatch bound does not accept what this produced: %v", err)
	}
}
