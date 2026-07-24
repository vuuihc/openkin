package kinagent

import (
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/vuuihc/kin/internal/provider"
)

// Max size of a single image we will base64-embed into a chat request.
// Larger images still keep a path pointer so tools can open them.
const maxVisionImageBytes = 8 << 20 // 8 MiB

// Matches the Composer-injected attachment block and looser "Attached …:" lines.
// Example:
//
//	Attached image:
//	- shot.png: /Users/me/.kin/uploads/abc.png
var attachedBlockRe = regexp.MustCompile(`(?is)(?:^|\n)Attached (?:image|file|files):\n((?:[ \t]*-[ \t].+\n?)*)`)
var attachedLineRe = regexp.MustCompile(`(?m)^[ \t]*-[ \t]+(.+?):\s+(\S+)\s*$`)

// expandUserMessage turns a plain user prompt (optionally ending with an
// "Attached image/file(s):" path list) into a provider.Message. Image paths are
// read from disk and embedded as data-URI image_url parts when possible so
// vision-capable models can see them without an OCR detour. Non-image files and
// oversized/unreadable images keep a path pointer in the text part.
func expandUserMessage(userPrompt string) provider.Message {
	text, paths := splitAttachmentBlock(userPrompt)
	if len(paths) == 0 {
		return provider.Message{Role: provider.RoleUser, Content: userPrompt}
	}

	var parts []provider.ContentPart
	var textBits []string
	if strings.TrimSpace(text) != "" {
		textBits = append(textBits, strings.TrimSpace(text))
	}

	var imageNotes []string
	var fileNotes []string
	for _, p := range paths {
		label := p.label
		if label == "" {
			label = filepath.Base(p.path)
		}
		if isLikelyImagePath(p.path) {
			part, note, ok := loadImagePart(p.path, label)
			if ok {
				parts = append(parts, part)
				imageNotes = append(imageNotes, fmt.Sprintf("- %s (embedded for vision; path: %s)", label, p.path))
				continue
			}
			// Fall through to path-only note when embed fails.
			if note != "" {
				fileNotes = append(fileNotes, fmt.Sprintf("- %s: %s (%s)", label, p.path, note))
			} else {
				fileNotes = append(fileNotes, fmt.Sprintf("- %s: %s", label, p.path))
			}
			continue
		}
		fileNotes = append(fileNotes, fmt.Sprintf("- %s: %s", label, p.path))
	}

	if len(imageNotes) > 0 {
		textBits = append(textBits, "Attached image(s) are included as vision inputs below:\n"+strings.Join(imageNotes, "\n"))
	}
	if len(fileNotes) > 0 {
		textBits = append(textBits, "Attached file(s) available on disk (use tools to open):\n"+strings.Join(fileNotes, "\n"))
	}

	// Text part shown to the model (paths kept so tools can still open files).
	// Content field always stores the original prompt so resume can re-embed images.
	content := strings.Join(textBits, "\n\n")
	if content == "" {
		content = userPrompt
	}
	if len(parts) == 0 {
		// No embeddable images — pure text (paths still in content for tools).
		return provider.Message{Role: provider.RoleUser, Content: userPrompt}
	}

	// OpenAI vision: content is an array of parts; text first, then images.
	outParts := make([]provider.ContentPart, 0, 1+len(parts))
	if strings.TrimSpace(content) != "" {
		outParts = append(outParts, provider.ContentPart{Type: "text", Text: content})
	}
	outParts = append(outParts, parts...)
	return provider.Message{
		Role:    provider.RoleUser,
		Content: userPrompt, // original prompt for persistence / re-expand on resume
		Parts:   outParts,
	}
}

type attachPath struct {
	label string
	path  string
}

// splitAttachmentBlock peels Composer-style attachment lines from the prompt.
// Returns the user-facing text (attachment block removed) and the path list.
func splitAttachmentBlock(prompt string) (text string, paths []attachPath) {
	loc := attachedBlockRe.FindStringSubmatchIndex(prompt)
	if loc == nil {
		// Also accept a lone trailing path list without the header (defensive).
		return prompt, nil
	}
	block := prompt[loc[2]:loc[3]]
	// Text is everything outside the matched block (header + lines).
	// loc[0]:loc[1] covers the full match including optional leading newline.
	text = strings.TrimSpace(prompt[:loc[0]] + prompt[loc[1]:])
	for _, m := range attachedLineRe.FindAllStringSubmatch(block, -1) {
		if len(m) < 3 {
			continue
		}
		label := strings.TrimSpace(m[1])
		path := strings.TrimSpace(m[2])
		if path == "" {
			continue
		}
		paths = append(paths, attachPath{label: label, path: path})
	}
	return text, paths
}

func isLikelyImagePath(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg":
		return true
	}
	return false
}

func loadImagePart(path, label string) (provider.ContentPart, string, bool) {
	fi, err := os.Stat(path)
	if err != nil {
		return provider.ContentPart{}, "unreadable: " + err.Error(), false
	}
	if fi.IsDir() {
		return provider.ContentPart{}, "is a directory", false
	}
	if fi.Size() <= 0 {
		return provider.ContentPart{}, "empty file", false
	}
	if fi.Size() > maxVisionImageBytes {
		return provider.ContentPart{}, fmt.Sprintf("too large for vision embed (>%d MiB)", maxVisionImageBytes>>20), false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return provider.ContentPart{}, "read failed: " + err.Error(), false
	}
	mimeType := detectImageMIME(path, data)
	if mimeType == "" {
		return provider.ContentPart{}, "unsupported image type", false
	}
	// SVG is accepted by uploads but many vision APIs reject it; skip embed.
	if mimeType == "image/svg+xml" {
		return provider.ContentPart{}, "svg not embedded (use tools)", false
	}
	// Guard against accidental non-image binary that snuck past extension check.
	if !strings.HasPrefix(mimeType, "image/") {
		return provider.ContentPart{}, "not an image", false
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	dataURI := "data:" + mimeType + ";base64," + b64
	return provider.ContentPart{
		Type: "image_url",
		ImageURL: &provider.ImageURL{
			URL:    dataURI,
			Detail: "auto",
		},
	}, "", true
}

func detectImageMIME(path string, data []byte) string {
	// Prefer magic-bytes sniff; fall back to extension.
	if snip := http.DetectContentType(data); strings.HasPrefix(snip, "image/") {
		// http.DetectContentType returns "image/jpeg" etc.; good enough.
		// It may return "text/xml; charset=utf-8" for SVG — handle via ext.
		if snip != "application/octet-stream" {
			// Strip any parameters.
			if i := strings.IndexByte(snip, ';'); i >= 0 {
				snip = strings.TrimSpace(snip[:i])
			}
			if snip != "text/xml" && snip != "text/plain" && snip != "application/xml" {
				return snip
			}
		}
	}
	ext := strings.ToLower(filepath.Ext(path))
	if mt := mime.TypeByExtension(ext); strings.HasPrefix(mt, "image/") {
		if i := strings.IndexByte(mt, ';'); i >= 0 {
			mt = strings.TrimSpace(mt[:i])
		}
		return mt
	}
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	}
	// Last resort: if the first bytes look like UTF-8 SVG.
	if len(data) > 0 && utf8.Valid(data[:min(len(data), 256)]) && strings.Contains(strings.ToLower(string(data[:min(len(data), 256)])), "<svg") {
		return "image/svg+xml"
	}
	return ""
}
