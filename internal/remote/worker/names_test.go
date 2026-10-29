package worker

import (
	"strings"
	"testing"
)

func TestSafeAttachmentName(t *testing.T) {
	cases := map[string]bool{
		"ab12cd34ef56.png":       true,
		"ab12cd34ef56":           true,
		"notes.md":               true,
		"":                       false,
		".":                      false,
		"..":                     false,
		"../secret":              false,
		"a/b.png":                false,
		`a\b.png`:                false,
		"a..b.png":               false,
		"a\x00.png":              false,
		"a\nb.png":               false,
		strings.Repeat("a", 129): false,
		strings.Repeat("a", 128): true,
		"shot (1).png":           true, // a name from a phone, kept as one element
		"文档/说明.md":               false,
		"说明.md":                  true,
	}
	for name, want := range cases {
		if got := SafeAttachmentName(name); got != want {
			t.Fatalf("SafeAttachmentName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestSafeTaskID(t *testing.T) {
	cases := map[string]bool{
		"01J8ZQ6Q2K7YV0J9W1X2Y3Z4AB": true,
		"task-1":                     true,
		"task_1.run":                 true,
		"":                           false,
		".":                          false,
		"..":                         false,
		"../task":                    false,
		"a/b":                        false,
		"a b":                        false,
		"任务":                         false,
		strings.Repeat("a", 129):     false,
	}
	for id, want := range cases {
		if got := SafeTaskID(id); got != want {
			t.Fatalf("SafeTaskID(%q) = %v, want %v", id, got, want)
		}
	}
}
