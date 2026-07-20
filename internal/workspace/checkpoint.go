package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	MaxCheckpointFileBytes  int64 = 16 << 20
	MaxCheckpointTotalBytes int64 = 256 << 20
)

var objectIDPattern = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// Capture records the current isolated worktree content as a private Git tree.
func (m *Manager) Capture(ctx context.Context, meta Metadata, taskID string, eventSeq int) (Checkpoint, error) {
	if m == nil {
		return Checkpoint{}, fmt.Errorf("workspace manager is nil")
	}
	if eventSeq < 0 {
		return Checkpoint{}, fmt.Errorf("event sequence must be >= 0")
	}
	if err := m.validateIsolatedMetadata(taskID, meta); err != nil {
		return Checkpoint{}, err
	}
	sizeBytes, err := m.checkSnapshotSize(ctx, meta.Root)
	if err != nil {
		return Checkpoint{}, err
	}

	taskDir, objectsDir, err := m.ensureCheckpointDirs(taskID)
	if err != nil {
		return Checkpoint{}, err
	}
	indexFile, err := os.CreateTemp(taskDir, "index-*")
	if err != nil {
		return Checkpoint{}, fmt.Errorf("create checkpoint index: %w", err)
	}
	indexPath := indexFile.Name()
	if err := indexFile.Close(); err != nil {
		_ = os.Remove(indexPath)
		return Checkpoint{}, err
	}
	// Let git create the temporary index from scratch.
	_ = os.Remove(indexPath)
	defer func() { _ = os.Remove(indexPath) }()

	normalObjects, err := m.normalObjectDir(ctx, meta.Root)
	if err != nil {
		return Checkpoint{}, err
	}
	env := map[string]string{
		"GIT_INDEX_FILE":                   indexPath,
		"GIT_OBJECT_DIRECTORY":             objectsDir,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES": normalObjects,
	}

	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if _, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "read-tree", "HEAD"); err != nil {
		return Checkpoint{}, err
	}
	if _, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "add", "-A", "--", "."); err != nil {
		return Checkpoint{}, err
	}
	treeOut, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "write-tree")
	if err != nil {
		return Checkpoint{}, err
	}
	headOut, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "rev-parse", "HEAD")
	if err != nil {
		return Checkpoint{}, err
	}

	treeOID := strings.TrimSpace(string(treeOut))
	headOID := strings.TrimSpace(string(headOut))
	if !validObjectID(treeOID) || !validObjectID(headOID) {
		return Checkpoint{}, ErrCheckpointUnavailable
	}
	return Checkpoint{
		TaskID:    taskID,
		EventSeq:  eventSeq,
		HeadOID:   headOID,
		TreeOID:   treeOID,
		SizeBytes: sizeBytes,
		CreatedAt: m.now().UnixMilli(),
	}, nil
}

// Restore materializes a checkpoint as ordinary working-tree changes.
func (m *Manager) Restore(ctx context.Context, meta Metadata, taskID string, cp Checkpoint) error {
	if cp.TaskID != taskID {
		return fmt.Errorf("%w: checkpoint task mismatch", ErrCheckpointUnavailable)
	}
	if err := m.validateIsolatedMetadata(taskID, meta); err != nil {
		return err
	}
	return m.restoreTree(ctx, meta, cp, cp.TaskID)
}

// PrepareFork creates a new isolated worktree and materializes a source checkpoint into it.
func (m *Manager) PrepareFork(ctx context.Context, newTaskID string, source Metadata, cp Checkpoint) (Metadata, error) {
	if m == nil {
		return Metadata{}, fmt.Errorf("workspace manager is nil")
	}
	if err := m.validateIsolatedMetadata(cp.TaskID, source); err != nil {
		return Metadata{}, err
	}
	if !taskIDPattern.MatchString(newTaskID) {
		return Metadata{}, fmt.Errorf("%w: %q", ErrInvalidTaskID, newTaskID)
	}
	if !validObjectID(cp.HeadOID) || !validObjectID(cp.TreeOID) {
		return Metadata{}, ErrCheckpointUnavailable
	}

	wtPath, err := m.worktreePath(newTaskID)
	if err != nil {
		return Metadata{}, err
	}
	if _, err := os.Stat(wtPath); err == nil {
		return Metadata{}, fmt.Errorf("%w: %s", ErrWorktreeExists, wtPath)
	} else if !os.IsNotExist(err) {
		return Metadata{}, err
	}
	if err := os.MkdirAll(filepath.Join(m.stateDir, "worktrees"), 0o700); err != nil {
		return Metadata{}, fmt.Errorf("mkdir worktrees: %w", err)
	}

	branch := worktreeBranch(newTaskID)
	addCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := m.git.Run(addCtx, source.SourceRoot, nil, ControlStdoutLimit,
		"worktree", "add", "-b", branch, wtPath, cp.HeadOID); err != nil {
		_ = m.safeRemoveWorktreeDir(wtPath)
		return Metadata{}, err
	}

	execCwd := wtPath
	if source.Scope != "" && source.Scope != "." {
		execCwd = filepath.Join(wtPath, filepath.FromSlash(source.Scope))
	}
	meta := Metadata{
		Mode:       ResolvedWorktree,
		SourceRoot: source.SourceRoot,
		Root:       wtPath,
		Cwd:        execCwd,
		Scope:      source.Scope,
		BaseOID:    source.BaseOID,
		Branch:     branch,
		Reason:     "forked from checkpoint",
	}
	if meta.Scope == "" {
		meta.Scope = "."
	}
	if err := m.restoreTree(ctx, meta, cp, cp.TaskID); err != nil {
		_ = m.CleanupPrepared(context.Background(), newTaskID, meta)
		return Metadata{}, err
	}
	return meta, nil
}

func (m *Manager) restoreTree(ctx context.Context, meta Metadata, cp Checkpoint, checkpointOwner string) error {
	if !taskIDPattern.MatchString(checkpointOwner) {
		return fmt.Errorf("%w: %q", ErrInvalidTaskID, checkpointOwner)
	}
	if !validObjectID(cp.HeadOID) || !validObjectID(cp.TreeOID) {
		return ErrCheckpointUnavailable
	}
	_, objectsDir, err := m.checkpointDirs(checkpointOwner)
	if err != nil {
		return err
	}
	if _, err := os.Stat(objectsDir); err != nil {
		if os.IsNotExist(err) {
			return ErrCheckpointUnavailable
		}
		return err
	}
	if err := m.assertExistingDirContained(objectsDir, filepath.Join(m.stateDir, "checkpoints")); err != nil {
		return err
	}

	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if _, err := m.git.Run(runCtx, meta.Root, nil, ControlStdoutLimit, "reset", "--hard", cp.HeadOID); err != nil {
		return err
	}
	if _, err := m.git.Run(runCtx, meta.Root, nil, ControlStdoutLimit, "clean", "-fd"); err != nil {
		return err
	}
	env := map[string]string{"GIT_ALTERNATE_OBJECT_DIRECTORIES": objectsDir}
	if _, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "read-tree", "--reset", "-u", cp.TreeOID); err != nil {
		return err
	}
	if _, err := m.git.Run(runCtx, meta.Root, env, ControlStdoutLimit, "reset", "--mixed", cp.HeadOID); err != nil {
		return err
	}
	return nil
}

func (m *Manager) validateIsolatedMetadata(taskID string, meta Metadata) error {
	if meta.Mode != ResolvedWorktree {
		return ErrNotIsolated
	}
	if !taskIDPattern.MatchString(taskID) {
		return fmt.Errorf("%w: %q", ErrInvalidTaskID, taskID)
	}
	expected, err := m.worktreePath(taskID)
	if err != nil {
		return err
	}
	if filepath.Clean(meta.Root) != filepath.Clean(expected) {
		return fmt.Errorf("%w: metadata root mismatch", ErrNotIsolated)
	}
	if err := m.assertExistingDirContained(meta.Root, filepath.Join(m.stateDir, "worktrees")); err != nil {
		return err
	}
	if meta.Cwd != "" {
		rel, err := filepath.Rel(filepath.Clean(meta.Root), filepath.Clean(meta.Cwd))
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return fmt.Errorf("%w: cwd outside worktree", ErrNotIsolated)
		}
	}
	return nil
}

func (m *Manager) checkSnapshotSize(ctx context.Context, root string) (int64, error) {
	out, err := m.git.Run(ctx, root, nil, PathListStdoutLimit, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return 0, err
	}
	var total int64
	for _, rel := range parseStatusPaths(out) {
		size, err := regularFileSize(root, rel)
		if err != nil {
			return 0, err
		}
		if size > MaxCheckpointFileBytes {
			return 0, ErrSnapshotTooLarge
		}
		total += size
		if total > MaxCheckpointTotalBytes {
			return 0, ErrSnapshotTooLarge
		}
	}
	return total, nil
}

func parseStatusPaths(out []byte) []string {
	records := strings.Split(string(out), "\x00")
	paths := make([]string, 0, len(records))
	skipNext := false
	for _, rec := range records {
		if rec == "" {
			continue
		}
		if skipNext {
			skipNext = false
			continue
		}
		if len(rec) < 4 || rec[2] != ' ' {
			continue
		}
		x, y := rec[0], rec[1]
		if !statusCode(x) || !statusCode(y) {
			continue
		}
		paths = append(paths, rec[3:])
		if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
			skipNext = true
		}
	}
	return paths
}

func statusCode(b byte) bool {
	return b == ' ' || b == '?' || b == '!' || b == 'M' || b == 'A' || b == 'D' ||
		b == 'R' || b == 'C' || b == 'U' || b == 'T'
}

func regularFileSize(root, rel string) (int64, error) {
	if filepath.IsAbs(rel) {
		return 0, fmt.Errorf("%w: absolute status path", ErrNotIsolated)
	}
	path := filepath.Clean(filepath.Join(root, filepath.FromSlash(rel)))
	rootClean := filepath.Clean(root)
	back, err := filepath.Rel(rootClean, path)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return 0, fmt.Errorf("%w: status path escapes worktree", ErrNotIsolated)
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	if !info.Mode().IsRegular() {
		return 0, nil
	}
	return info.Size(), nil
}

func (m *Manager) normalObjectDir(ctx context.Context, root string) (string, error) {
	out, err := m.git.Run(ctx, root, nil, ControlStdoutLimit, "rev-parse", "--git-common-dir")
	if err != nil {
		return "", err
	}
	common := strings.TrimSpace(string(out))
	if common == "" {
		return "", ErrCheckpointUnavailable
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(root, common)
	}
	common = filepath.Clean(common)
	if resolved, err := filepath.EvalSymlinks(common); err == nil {
		common = resolved
	}
	return filepath.Join(common, "objects"), nil
}

func (m *Manager) ensureCheckpointDirs(taskID string) (string, string, error) {
	taskDir, objectsDir, err := m.checkpointDirs(taskID)
	if err != nil {
		return "", "", err
	}
	root := filepath.Join(m.stateDir, "checkpoints")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", "", fmt.Errorf("mkdir checkpoints: %w", err)
	}
	for _, p := range []string{taskDir, objectsDir} {
		if info, err := os.Lstat(p); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return "", "", fmt.Errorf("%w: checkpoint path is symlink", ErrNotIsolated)
			}
		} else if !os.IsNotExist(err) {
			return "", "", err
		}
		if err := os.MkdirAll(p, 0o700); err != nil {
			return "", "", fmt.Errorf("mkdir checkpoint path: %w", err)
		}
		if err := m.assertExistingDirContained(p, root); err != nil {
			return "", "", err
		}
	}
	return taskDir, objectsDir, nil
}

func (m *Manager) checkpointDirs(taskID string) (string, string, error) {
	if !taskIDPattern.MatchString(taskID) {
		return "", "", fmt.Errorf("%w: %q", ErrInvalidTaskID, taskID)
	}
	taskDir := filepath.Join(m.stateDir, "checkpoints", taskID)
	return taskDir, filepath.Join(taskDir, "objects"), nil
}

func (m *Manager) assertExistingDirContained(path, root string) error {
	clean := filepath.Clean(path)
	rootClean := filepath.Clean(root)
	rel, err := filepath.Rel(rootClean, clean)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: path %s outside state root", ErrNotIsolated, path)
	}
	info, err := os.Lstat(clean)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: path %s is symlink", ErrNotIsolated, path)
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: path %s is not a directory", ErrNotIsolated, path)
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		return err
	}
	resolvedRoot, err := filepath.EvalSymlinks(rootClean)
	if err != nil {
		return err
	}
	rel, err = filepath.Rel(resolvedRoot, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: path %s escapes state root", ErrNotIsolated, path)
	}
	if rel == "." {
		return fmt.Errorf("%w: path is state root", ErrNotIsolated)
	}
	return nil
}

func validObjectID(oid string) bool {
	return objectIDPattern.MatchString(oid)
}
