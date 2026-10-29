package workspace

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	liveTreeLimit = 500
	liveFileLimit = 1024 * 1024
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

// ListLiveTree lists the actual filesystem contents for a live workspace or
// source checkout. Paths are repository-relative and constrained to meta.Scope.
func (m *Manager) ListLiveTree(_ context.Context, meta Metadata, relDir string) ([]TreeEntry, bool, error) {
	return ListLiveTree(meta, relDir)
}

// ListLiveTree lists one level of an existing directory beneath a rooted
// workspace.
//
// It is the package function and not only a manager method because listing a
// directory needs no git and no state directory: a machine that cannot run git
// still has directories, and can still answer what is inside one.
func ListLiveTree(meta Metadata, relDir string) ([]TreeEntry, bool, error) {
	rootPath, rel, err := rootedLivePath(meta, relDir)
	if err != nil {
		return nil, false, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, false, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()
	dir, err := root.Open(rel)
	if err != nil {
		return nil, false, fmt.Errorf("open live tree: %w", err)
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return nil, false, fmt.Errorf("stat live tree: %w", err)
	}
	if !info.IsDir() {
		return nil, false, fmt.Errorf("live path is not a directory")
	}
	// A bounded read that finds nothing reports io.EOF, which is how an empty
	// directory reads: not a failure, and not a reason to refuse to list one.
	entries, err := dir.ReadDir(liveTreeLimit + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false, fmt.Errorf("read live tree: %w", err)
	}
	truncated := len(entries) > liveTreeLimit
	out := make([]TreeEntry, 0, min(len(entries), liveTreeLimit))
	for _, entry := range entries {
		if len(out) >= liveTreeLimit {
			break
		}
		if isGitMetadataPath(entry.Name()) {
			continue
		}
		child, err := root.Open(filepath.Join(rel, entry.Name()))
		if err != nil {
			continue
		}
		entryInfo, err := child.Stat()
		_ = child.Close()
		if err != nil {
			continue
		}
		item := TreeEntry{Name: entry.Name()}
		if entryInfo.IsDir() {
			item.Type = "tree"
		} else if entryInfo.Mode().IsRegular() {
			item.Type = "blob"
			item.Size = entryInfo.Size()
		} else {
			continue
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "tree"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, truncated, nil
}

// ReadLiveFile reads the actual filesystem contents for a live workspace or
// source checkout.
func (m *Manager) ReadLiveFile(_ context.Context, meta Metadata, relPath string) ([]byte, error) {
	return ReadLiveFile(meta, relPath)
}

// ReadLiveFile reads an existing UTF-8 file beneath a rooted workspace.
func ReadLiveFile(meta Metadata, relPath string) ([]byte, error) {
	rootPath, rel, err := rootedLivePath(meta, relPath)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()
	file, err := root.Open(rel)
	if err != nil {
		return nil, fmt.Errorf("open live file: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat live file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("live path is not a regular file")
	}
	if info.Size() > liveFileLimit {
		return nil, fmt.Errorf("%w: file exceeds %d bytes", ErrOutputTooLarge, liveFileLimit)
	}
	data, err := io.ReadAll(io.LimitReader(file, liveFileLimit+1))
	if err != nil {
		return nil, fmt.Errorf("read live file: %w", err)
	}
	if len(data) > liveFileLimit {
		return nil, fmt.Errorf("%w: file exceeds %d bytes", ErrOutputTooLarge, liveFileLimit)
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return nil, fmt.Errorf("live file is not UTF-8 text")
	}
	return data, nil
}

// TrimValidUTF8 drops the bytes a cut left in the middle of a rune.
//
// Truncating text at a byte boundary can end it mid-character, and half a
// character is not text: encoding/json replaces it on the way out, which puts a
// character in the answer that is not in the file. Every place that shows the
// beginning of a file cuts it here, so that what a reader sees is what the file
// says.
func TrimValidUTF8(data []byte) []byte {
	for len(data) > 0 && !utf8.Valid(data) {
		data = data[:len(data)-1]
	}
	return data
}

// WriteLiveFile replaces an existing UTF-8 file in a live workspace.
func (m *Manager) WriteLiveFile(_ context.Context, meta Metadata, relPath, content string) ([]byte, error) {
	return WriteLiveFile(meta, relPath, content)
}

// WriteLiveFile replaces an existing UTF-8 file beneath a rooted workspace.
// It is also used by the legacy shared-workspace compatibility handler.
func WriteLiveFile(meta Metadata, relPath, content string) ([]byte, error) {
	if len(content) > liveFileLimit {
		return nil, fmt.Errorf("%w: file exceeds %d bytes", ErrOutputTooLarge, liveFileLimit)
	}
	if !utf8.ValidString(content) {
		return nil, fmt.Errorf("live file content is not valid UTF-8")
	}
	if strings.IndexByte(content, 0) >= 0 {
		return nil, fmt.Errorf("live file content contains NUL")
	}
	rootPath, rel, err := rootedLivePath(meta, relPath)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()
	file, err := root.Open(rel)
	if err != nil {
		return nil, fmt.Errorf("open live file: %w", err)
	}
	info, err := file.Stat()
	closeErr := file.Close()
	if err != nil {
		return nil, fmt.Errorf("stat live file: %w", err)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close live file: %w", closeErr)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("live path is not a regular file")
	}
	dir, base := filepath.Dir(rel), filepath.Base(rel)
	var tempPath string
	var temp *os.File
	for range 10 {
		var suffix [8]byte
		if _, err := rand.Read(suffix[:]); err != nil {
			return nil, fmt.Errorf("create live file temporary name: %w", err)
		}
		tempPath = filepath.Join(dir, "."+base+".kin-tmp-"+hex.EncodeToString(suffix[:]))
		temp, err = root.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("create live file temporary: %w", err)
		}
	}
	if temp == nil {
		return nil, fmt.Errorf("create live file temporary: name collision")
	}
	defer func() { _ = root.Remove(tempPath) }()
	if err := temp.Chmod(info.Mode().Perm()); err != nil {
		_ = temp.Close()
		return nil, fmt.Errorf("set live file mode: %w", err)
	}
	if _, err := io.WriteString(temp, content); err != nil {
		_ = temp.Close()
		return nil, fmt.Errorf("write live file: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return nil, fmt.Errorf("sync live file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return nil, fmt.Errorf("close live file: %w", err)
	}
	if err := root.Rename(tempPath, rel); err != nil {
		return nil, fmt.Errorf("replace live file: %w", err)
	}
	return []byte(content), nil
}

func rootedLivePath(meta Metadata, relPath string) (root, rel string, err error) {
	root = strings.TrimSpace(meta.Root)
	if root == "" {
		return "", "", fmt.Errorf("workspace root is empty")
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", "", fmt.Errorf("resolve workspace root: %w", err)
	}
	if relPath == "" {
		relPath = "."
	}
	if err := validateRelPath(relPath); err != nil {
		return "", "", err
	}
	if isGitMetadataPath(relPath) {
		return "", "", fmt.Errorf("path %q refers to Git metadata", relPath)
	}
	scope := filepath.Clean(filepath.FromSlash(meta.Scope))
	if scope == "" {
		scope = "."
	}
	rel = filepath.Clean(filepath.FromSlash(relPath))
	if scope != "." && rel != scope && !strings.HasPrefix(rel, scope+string(filepath.Separator)) {
		return "", "", fmt.Errorf("path %q is outside workspace scope %q", relPath, meta.Scope)
	}
	return root, rel, nil
}

func isGitMetadataPath(path string) bool {
	for _, part := range strings.FieldsFunc(filepath.ToSlash(path), func(r rune) bool {
		return r == '/'
	}) {
		if strings.EqualFold(part, ".git") {
			return true
		}
	}
	return false
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

// checkpointEnv is the object-store environment that makes a task's private
// checkpoint objects readable from inside its worktree.
//
// The checkpoint objects are written to their own directory (`git write-tree`
// with GIT_OBJECT_DIRECTORY set), so a later diff has to point git at that
// directory and at the repository's own objects, which the trees still refer to.
// The empty map means the task has no checkpoint store to read.
func (m *Manager) checkpointEnv(ctx context.Context, taskID string, meta Metadata) map[string]string {
	env := map[string]string{}
	objectsDir := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	if fi, err := os.Stat(objectsDir); err != nil || !fi.IsDir() {
		return env
	}
	if normalObjects, err := m.normalObjectDir(ctx, meta.SourceRoot); err == nil {
		env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = normalObjects
	}
	env["GIT_OBJECT_DIRECTORY"] = objectsDir
	return env
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
	env := m.checkpointEnv(ctx, taskID, meta)

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

// ListTreeChanges returns what differs between two checkpoint trees.
//
// This is the workspace's own answer to "what did this round change": both
// sides are snapshots captured from disk, so an edit no file tool reported — a
// shell command, a formatter, a generator — is in here like any other. The
// caller supplies the pair; deciding which checkpoint bounds a round is not
// this layer's business.
func (m *Manager) ListTreeChanges(ctx context.Context, taskID string, meta Metadata, baseTreeOID, headTreeOID string) ([]Change, error) {
	if m == nil {
		return nil, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return nil, fmt.Errorf("git runner not available")
	}
	if !validObjectID(baseTreeOID) || !validObjectID(headTreeOID) {
		return nil, ErrCheckpointUnavailable
	}
	env := m.checkpointEnv(ctx, taskID, meta)
	if env["GIT_OBJECT_DIRECTORY"] == "" {
		return nil, ErrCheckpointUnavailable
	}

	runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	hooks := "-c"
	hooksPath := "core.hooksPath=" + m.emptyHooksDir()

	out, err := m.git.Run(runCtx, meta.Root, env, PathListStdoutLimit,
		hooks, hooksPath,
		"diff-tree", "--no-commit-id", "-r", "--name-status", "--find-renames",
		baseTreeOID, headTreeOID)
	if err != nil {
		return nil, fmt.Errorf("list checkpoint tree changes: %w", err)
	}
	changes := parseNameStatus(string(out))
	if len(changes) == 0 {
		return changes, nil
	}

	// One pass for the line counts. `--no-renames` keeps this list keyed by
	// paths the status pass already reported: a rename shows up as its deleted
	// and added halves, and the rename entry itself keeps no counts rather than
	// claiming the whole file was added.
	numstat, err := m.git.Run(runCtx, meta.Root, env, PathListStdoutLimit,
		hooks, hooksPath,
		"diff-tree", "--no-commit-id", "-r", "--numstat", "--no-renames",
		baseTreeOID, headTreeOID)
	if err != nil {
		// Counts are decoration; the file list is the answer.
		return changes, nil
	}
	counts := parseNumstat(string(numstat))
	for i, c := range changes {
		if c.Status == "renamed" {
			continue
		}
		if count, ok := counts[c.Path]; ok {
			changes[i].Additions = count.Additions
			changes[i].Deletions = count.Deletions
			changes[i].Binary = count.Binary
		}
	}
	return changes, nil
}

// parseNumstat reads `diff-tree --numstat` output into per-path counts.
//
// A binary file reports "-" for both counts; it is kept as a binary entry with
// no counts rather than as a file that changed by zero lines.
func parseNumstat(output string) map[string]Change {
	out := make(map[string]Change)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) < 3 {
			continue
		}
		path := fields[2]
		if fields[0] == "-" || fields[1] == "-" {
			out[path] = Change{Path: path, Binary: true}
			continue
		}
		additions, addErr := strconv.Atoi(fields[0])
		deletions, delErr := strconv.Atoi(fields[1])
		if addErr != nil || delErr != nil {
			continue
		}
		out[path] = Change{Path: path, Additions: additions, Deletions: deletions}
	}
	return out
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
	env := m.checkpointEnv(ctx, taskID, meta)

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
