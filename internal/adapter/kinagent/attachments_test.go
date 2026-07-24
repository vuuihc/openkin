package kinagent

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vuuihc/kin/internal/provider"
)

// 1x1 PNG
var onePixelPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func TestExpandUserMessageEmbedsImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(path, onePixelPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	prompt := "what is in this screenshot?\n\nAttached image:\n- shot.png: " + path
	msg := expandUserMessage(prompt)
	if msg.Role != provider.RoleUser {
		t.Fatalf("role = %q", msg.Role)
	}
	if msg.Content != prompt {
		t.Fatalf("Content should stay original for resume, got %q", msg.Content)
	}
	if len(msg.Parts) < 2 {
		t.Fatalf("want text+image parts, got %#v", msg.Parts)
	}
	if msg.Parts[0].Type != "text" || !strings.Contains(msg.Parts[0].Text, "screenshot") {
		t.Fatalf("text part = %#v", msg.Parts[0])
	}
	img := msg.Parts[1]
	if img.Type != "image_url" || img.ImageURL == nil {
		t.Fatalf("image part = %#v", img)
	}
	wantPrefix := "data:image/png;base64,"
	if !strings.HasPrefix(img.ImageURL.URL, wantPrefix) {
		got := img.ImageURL.URL
		if len(got) > 40 {
			got = got[:40]
		}
		t.Fatalf("data uri prefix = %q", got)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(img.ImageURL.URL, wantPrefix))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != len(onePixelPNG) {
		t.Fatalf("decoded len %d want %d", len(raw), len(onePixelPNG))
	}
}

func TestExpandUserMessageNoAttachment(t *testing.T) {
	msg := expandUserMessage("hello only")
	if len(msg.Parts) != 0 || msg.Content != "hello only" {
		t.Fatalf("unexpected %#v", msg)
	}
}

func TestExpandUserMessageMissingFileKeepsPath(t *testing.T) {
	prompt := "see this\n\nAttached image:\n- gone.png: /no/such/file.png"
	msg := expandUserMessage(prompt)
	if len(msg.Parts) != 0 {
		t.Fatalf("should not embed missing image: %#v", msg.Parts)
	}
	if msg.Content != prompt {
		t.Fatalf("content = %q", msg.Content)
	}
}

func TestSplitAttachmentBlock(t *testing.T) {
	text, paths := splitAttachmentBlock("hi\n\nAttached files:\n- a.txt: /tmp/a.txt\n- b.png: /tmp/b.png\n")
	if text != "hi" {
		t.Fatalf("text = %q", text)
	}
	if len(paths) != 2 || paths[0].path != "/tmp/a.txt" || paths[1].label != "b.png" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestBuildInitialMessagesExpandsVision(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.png")
	if err := os.WriteFile(path, onePixelPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	prompt := "look\n\nAttached image:\n- x.png: " + path
	msgs := buildInitialMessages("sys", prompt, nil)
	if len(msgs) != 2 {
		t.Fatalf("len = %d", len(msgs))
	}
	if len(msgs[1].Parts) < 2 {
		t.Fatalf("user parts = %#v", msgs[1].Parts)
	}
}
