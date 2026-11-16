package node

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/vuuihc/openkin/internal/attach"
	"github.com/vuuihc/openkin/internal/remote/worker"
)

// hubAttachments lists the files a prompt names that this Hub can ship.
//
// A prompt carries attachment paths as text, and on the machine that runs the
// turn those paths are addresses to nothing: the upload lives in this Hub's
// state directory. So the dispatch says which of them this Hub is the source
// of truth for, and the Node fetches those. Everything else in the block — a
// path a person typed, a file on a machine the Hub knows nothing about — is
// left alone, because a Hub that claimed it would send a Node looking for a
// file whose owner it is not.
//
// Only paths directly inside the uploads directory count, and only regular
// files that are there now. The uploads directory is flat by construction
// (handleUpload writes `<id><ext>` into it), so a path below a subdirectory is
// not one this Hub put there.
func hubAttachments(prompt, uploadsDir string) []worker.Attachment {
	dir := strings.TrimSpace(uploadsDir)
	if dir == "" || prompt == "" {
		return nil
	}
	dir = filepath.Clean(dir)
	_, entries := attach.Split(prompt)
	if len(entries) == 0 {
		return nil
	}
	out := make([]worker.Attachment, 0, len(entries))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if len(out) == worker.MaxAttachments {
			// Past the bound the remaining paths keep the wording they have
			// today — an address the Node cannot open — rather than growing a
			// frame until the protocol refuses it.
			break
		}
		// Clean for the containment check; keep the raw text for the rewrite,
		// which replaces exactly what the prompt contains.
		path := filepath.Clean(entry.Path)
		if seen[path] || filepath.Dir(path) != dir {
			continue
		}
		name := filepath.Base(path)
		if !worker.SafeAttachmentName(name) {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		seen[path] = true
		out = append(out, worker.Attachment{Path: entry.Path, Stored: name})
	}
	return out
}
