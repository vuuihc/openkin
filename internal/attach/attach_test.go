package attach

import (
	"testing"
)

func TestSplitPeelsTheBlockAndKeepsTheText(t *testing.T) {
	cases := []struct {
		name    string
		prompt  string
		text    string
		entries []Entry
	}{
		{
			name:   "no block is the common case",
			prompt: "fix the failing test",
			text:   "fix the failing test",
		},
		{
			name:   "one image",
			prompt: "look at this\n\nAttached image:\n- shot.png: /Users/me/.kin/uploads/ab12.png",
			text:   "look at this",
			entries: []Entry{
				{Label: "shot.png", Path: "/Users/me/.kin/uploads/ab12.png"},
			},
		},
		{
			name:   "several files",
			prompt: "compare\n\nAttached files:\n- a.txt: /tmp/a.txt\n- b.png: /tmp/b.png\n",
			text:   "compare",
			entries: []Entry{
				{Label: "a.txt", Path: "/tmp/a.txt"},
				{Label: "b.png", Path: "/tmp/b.png"},
			},
		},
		{
			name:   "attachments only, no text",
			prompt: "Attached file:\n- notes.md: /tmp/notes.md",
			text:   "",
			entries: []Entry{
				{Label: "notes.md", Path: "/tmp/notes.md"},
			},
		},
		{
			// The label is whatever the client wrote, and the composer passes
			// the upload's own name through: it can be in any script.
			name:   "a label in another script",
			prompt: "看看\n\nAttached image:\n- 截图.png: /tmp/x.png",
			text:   "看看",
			entries: []Entry{
				{Label: "截图.png", Path: "/tmp/x.png"},
			},
		},
		{
			// A file another machine could not bring over stands where its path
			// would, and the reader has to be told: dropping the note with the
			// block would leave a model believing the file was never mentioned.
			name: "a note keeps its place in the text",
			prompt: "what is this?\n\nAttached image:\n" +
				"- shot.png: (not transferred to this computer: the hub answered 404 Not Found — attach it again)\n" +
				"- ok.png: /tmp/ok.png",
			text: "what is this?\n\n" +
				"- shot.png: (not transferred to this computer: the hub answered 404 Not Found — attach it again)",
			entries: []Entry{
				{Label: "ok.png", Path: "/tmp/ok.png"},
			},
		},
		{
			// Without the header this is prose, not a block. Rewriting a line
			// that merely looks like one would change what the person wrote.
			name:   "a list with no header is text",
			prompt: "steps:\n- do this: first\n- do that: second",
			text:   "steps:\n- do this: first\n- do that: second",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text, entries := Split(tc.prompt)
			if text != tc.text {
				t.Fatalf("text = %q, want %q", text, tc.text)
			}
			if len(entries) != len(tc.entries) {
				t.Fatalf("entries = %#v, want %#v", entries, tc.entries)
			}
			for i, want := range tc.entries {
				if entries[i] != want {
					t.Fatalf("entries[%d] = %#v, want %#v", i, entries[i], want)
				}
			}
		})
	}
}

func TestSplitIgnoresAPathWithSpaces(t *testing.T) {
	// The composer writes unquoted paths; a line with a space in the path is
	// not one this format can carry, and inventing where the path ends would
	// rewrite text that is not a path.
	text, entries := Split("Attached file:\n- weird.txt: /tmp/a b.txt")
	if len(entries) != 0 {
		t.Fatalf("entries = %#v", entries)
	}
	// And the line is still there for whoever reads the prompt.
	if text != "- weird.txt: /tmp/a b.txt" {
		t.Fatalf("text = %q", text)
	}
}
