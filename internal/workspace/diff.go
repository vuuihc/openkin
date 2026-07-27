package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Change describes a single file change in a workspace diff.
type Change struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"` // added|modified|deleted|renamed|binary
	Additions int    `json:"additions,omitempty"`
	Deletions int    `json:"deletions,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
}

// TreeEntry is a single entry in a tree listing.
type TreeEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // blob|tree
	Size int64  `json:"size,omitempty"`
}

// ListLiveChanges returns the current working-tree changes in a live workspace.
// Uses git diff --name-status to detect renames and binary files.
func (m *Manager) ListLiveChanges(ctx context.Context, meta Metadata) ([]Change, error) {
	if m == nil {
		return nil, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return nil, fmt.Errorf("git runner not available")
	}

	hooksDir := m.emptyHooksDir()

	// Use --name-status for rename detection and basic status
	out, err := m.git.Run(ctx, meta.Root, nil, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"diff", "--name-status", "--find-renames", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("list live changes: %w", err)
	}

	changes := parseNameStatus(string(out))

	// Also get untracked files
	untrackedOut, err := m.git.Run(ctx, meta.Root, nil, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"ls-files", "--others", "--exclude-standard")
	if err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(untrackedOut)), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			changes = append(changes, Change{
				Path:   line,
				Status: "added",
			})
		}
	}

	// Get stat counts for modified files
	for i, c := range changes {
		if c.Status == "modified" || c.Status == "added" {
			statOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
				"-c", "core.hooksPath="+hooksDir,
				"diff", "--numstat", "HEAD", "--", c.Path)
			if err == nil {
				fields := strings.Fields(strings.TrimSpace(string(statOut)))
				if len(fields) >= 2 {
					if n, err := strconv.Atoi(fields[0]); err == nil {
						changes[i].Additions = n
					}
					if n, err := strconv.Atoi(fields[1]); err == nil {
						changes[i].Deletions = n
					}
				}
			}
		}
	}

	return changes, nil
}

// ListSnapshotChanges computes the diff between review_base_oid and final_tree_oid.
// Uses the checkpoint object directory as an alternate for reading final trees.
func (m *Manager) ListSnapshotChanges(ctx context.Context, taskID string, meta Metadata, reviewBaseOID, finalTreeOID string) ([]Change, error) {
	if m == nil {
		return nil, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return nil, fmt.Errorf("git runner not available")
	}

	hooksDir := m.emptyHooksDir()

	// Set up alternate object directory for checkpoint objects
	env := map[string]string{}
	objectsDir := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	if fi, err := os.Stat(objectsDir); err == nil && fi.IsDir() {
		normalObjects, err := m.normalObjectDir(ctx, meta.SourceRoot)
		if err == nil {
			env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = normalObjects
		}
		env["GIT_OBJECT_DIRECTORY"] = objectsDir
	}

	// Diff between review base tree and final tree
	out, err := m.git.Run(ctx, meta.SourceRoot, env, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"diff-tree", "--no-commit-id", "-r", "--name-status", "--find-renames",
		reviewBaseOID+"^{tree}", finalTreeOID)
	if err != nil {
		return nil, fmt.Errorf("list snapshot changes: %w", err)
	}

	return parseNameStatus(string(out)), nil
}

// ReadSnapshotFile reads a file from a git tree object.
// relPath must be a repository-relative path (no traversal).
func (m *Manager) ReadSnapshotFile(ctx context.Context, taskID string, meta Metadata, treeOID, relPath string) ([]byte, error) {
	if m == nil {
		return nil, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return nil, fmt.Errorf("git runner not available")
	}

	// Validate path: no traversal
	if err := validateRelPath(relPath); err != nil {
		return nil, err
	}

	hooksDir := m.emptyHooksDir()

	// Set up alternate object directory for checkpoint objects
	env := map[string]string{}
	objectsDir := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	if fi, err := os.Stat(objectsDir); err == nil && fi.IsDir() {
		normalObjects, err := m.normalObjectDir(ctx, meta.SourceRoot)
		if err == nil {
			env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = normalObjects
		}
		env["GIT_OBJECT_DIRECTORY"] = objectsDir
	}

	// Read blob from tree
	out, err := m.git.Run(ctx, meta.SourceRoot, env, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"cat-file", "blob", treeOID+":"+relPath)
	if err != nil {
		return nil, fmt.Errorf("read snapshot file %q: %w", relPath, err)
	}

	return out, nil
}

// ListSnapshotTree lists entries in a git tree object at the given path.
func (m *Manager) ListSnapshotTree(ctx context.Context, taskID string, meta Metadata, treeOID, relDir string) ([]TreeEntry, error) {
	if m == nil {
		return nil, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return nil, fmt.Errorf("git runner not available")
	}

	// Validate path
	if relDir != "" && relDir != "." {
		if err := validateRelPath(relDir); err != nil {
			return nil, err
		}
	}

	hooksDir := m.emptyHooksDir()

	// Set up alternate object directory for checkpoint objects
	env := map[string]string{}
	objectsDir := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	if fi, err := os.Stat(objectsDir); err == nil && fi.IsDir() {
		normalObjects, err := m.normalObjectDir(ctx, meta.SourceRoot)
		if err == nil {
			env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = normalObjects
		}
		env["GIT_OBJECT_DIRECTORY"] = objectsDir
	}

	// Resolve tree path
	targetTree := treeOID
	if relDir != "" && relDir != "." {
		targetTree = treeOID + ":" + relDir
	}

	// List tree
	out, err := m.git.Run(ctx, meta.SourceRoot, env, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"ls-tree", "-l", targetTree)
	if err != nil {
		return nil, fmt.Errorf("list snapshot tree %q: %w", relDir, err)
	}

	return parseTreeEntries(string(out)), nil
}

// parseNameStatus parses git diff --name-status output.
func parseNameStatus(output string) []Change {
	var changes []Change
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 2 {
			continue
		}
		statusCode := fields[0]
		switch {
		case strings.HasPrefix(statusCode, "R"):
			// Rename: R100\told\tnew
			if len(fields) >= 3 {
				changes = append(changes, Change{
					Status:  "renamed",
					OldPath: fields[1],
					Path:    fields[2],
				})
			}
		case statusCode == "A":
			changes = append(changes, Change{
				Status: "added",
				Path:   fields[1],
			})
		case statusCode == "D":
			changes = append(changes, Change{
				Status: "deleted",
				Path:   fields[1],
			})
		case statusCode == "M":
			changes = append(changes, Change{
				Status: "modified",
				Path:   fields[1],
			})
		case strings.HasPrefix(statusCode, "C"):
			// Copy
			if len(fields) >= 3 {
				changes = append(changes, Change{
					Status:  "added",
					OldPath: fields[1],
					Path:    fields[2],
				})
			}
		}
	}
	return changes
}

// parseTreeEntries parses git ls-tree -l output.
func parseTreeEntries(output string) []TreeEntry {
	var entries []TreeEntry
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Format: <mode> <type> <hash> <size>\t<name>
		// Or with -l: <mode> <type> <hash> <size>\t<name>
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) < 2 {
			continue
		}
		metaFields := strings.Fields(parts[0])
		if len(metaFields) < 3 {
			continue
		}
		entry := TreeEntry{
			Name: parts[1],
			Type: metaFields[1],
		}
		if len(metaFields) >= 4 && metaFields[1] == "blob" {
			if size, err := strconv.ParseInt(metaFields[3], 10, 64); err == nil {
				entry.Size = size
			}
		}
		entries = append(entries, entry)
	}
	return entries
}

// validateRelPath rejects paths that attempt traversal or are absolute.
func validateRelPath(path string) error {
	if path == "" {
		return fmt.Errorf("path is empty")
	}
	if filepath.IsAbs(path) {
		return fmt.Errorf("absolute path not allowed: %q", path)
	}
	clean := filepath.Clean(path)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path traversal not allowed: %q", path)
	}
	return nil
}
