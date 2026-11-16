package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolveSource captures the current source repository state for preparation.
func (m *Manager) ResolveSource(ctx context.Context, cwd string) (SourceMetadata, error) {
	if m == nil {
		return SourceMetadata{}, fmt.Errorf("workspace manager is nil")
	}

	probe, err := m.Probe(ctx, cwd)
	if err != nil {
		return SourceMetadata{}, err
	}

	headOID := probe.HeadOID
	if headOID == "" {
		return SourceMetadata{}, ErrNoHead
	}
	targetBranch, err := m.CurrentBranch(ctx, probe.SourceRoot)
	if err != nil {
		return SourceMetadata{}, err
	}
	if strings.TrimSpace(targetBranch) == "" {
		return SourceMetadata{}, fmt.Errorf("source repository is in detached HEAD")
	}

	return SourceMetadata{
		Cwd:          probe.Cwd,
		SourceRoot:   probe.SourceRoot,
		Scope:        probe.Scope,
		TargetBranch: targetBranch,
		HeadOID:      headOID,
		Dirty:        probe.Dirty,
	}, nil
}

// PrepareGeneration creates a new isolated worktree for a workspace generation.
// It validates the source, creates the worktree with a non-interactive git
// config that disables hooks, and returns the resolved Metadata.
func (m *Manager) PrepareGeneration(
	ctx context.Context,
	taskID string,
	generation int,
	source SourceMetadata,
) (Metadata, error) {
	if m == nil {
		return Metadata{}, fmt.Errorf("workspace manager is nil")
	}
	if generation <= 0 {
		return Metadata{}, fmt.Errorf("generation must be > 0")
	}
	if source.Dirty {
		return Metadata{}, fmt.Errorf("%w: source is dirty", ErrDirtySource)
	}
	if !validObjectID(source.HeadOID) {
		return Metadata{}, fmt.Errorf("%w: invalid source HEAD", ErrNoHead)
	}

	hooksDir := m.emptyHooksDir()
	if err := os.MkdirAll(hooksDir, 0o700); err != nil {
		return Metadata{}, fmt.Errorf("create empty hooks dir: %w", err)
	}

	wtPath, err := m.worktreePath(taskID, generation)
	if err != nil {
		return Metadata{}, err
	}

	branch := worktreeBranch(taskID, generation)
	meta := Metadata{
		Mode:         ResolvedWorktree,
		Generation:   generation,
		SourceRoot:   source.SourceRoot,
		Root:         wtPath,
		Cwd:          filepath.Join(wtPath, source.Scope),
		Scope:        source.Scope,
		BaseOID:      source.HeadOID,
		Branch:       branch,
		TargetBranch: source.TargetBranch,
	}
	if adopted, err := m.adoptPreparedGeneration(ctx, meta); adopted || err != nil {
		return meta, err
	}

	// Create the worktree with hooks disabled
	_, err = m.git.Run(ctx, source.SourceRoot, nil, PathListStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"worktree", "add", "--force", wtPath, source.HeadOID, "--detach")
	if err != nil {
		return meta, fmt.Errorf("create worktree: %w", err)
	}

	// Create and checkout the feature branch
	_, err = m.git.Run(ctx, wtPath, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir,
		"checkout", "-b", branch)
	if err != nil {
		// Clean up on failure
		_, _ = m.git.Run(ctx, source.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "worktree", "remove", "--force", wtPath)
		return meta, fmt.Errorf("create branch: %w", err)
	}
	headOut, err := m.git.Run(ctx, wtPath, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(string(headOut)) != source.HeadOID {
		_, _ = m.git.Run(ctx, source.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "worktree", "remove", "--force", wtPath)
		return meta, fmt.Errorf("prepared workspace HEAD does not match source snapshot")
	}

	return meta, nil
}

// adoptPreparedGeneration makes worktree preparation idempotent across a
// process crash after git created the deterministic path. Only the exact Kin
// path, source snapshot, and branch are accepted.
func (m *Manager) adoptPreparedGeneration(ctx context.Context, meta Metadata) (bool, error) {
	info, err := os.Stat(meta.Root)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return true, fmt.Errorf("%w: generation path is not a directory", ErrWorktreeExists)
	}
	headOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(string(headOut)) != meta.BaseOID {
		return true, fmt.Errorf("%w: existing generation has unexpected HEAD", ErrWorktreeExists)
	}
	branchOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return true, fmt.Errorf("inspect existing generation branch: %w", err)
	}
	currentBranch := strings.TrimSpace(string(branchOut))
	switch currentBranch {
	case meta.Branch:
		return true, nil
	case "HEAD":
		if _, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+m.emptyHooksDir(), "checkout", "-b", meta.Branch); err != nil {
			return true, fmt.Errorf("adopt existing generation branch: %w", err)
		}
		return true, nil
	default:
		return true, fmt.Errorf(
			"%w: existing generation uses branch %q", ErrWorktreeExists, currentBranch,
		)
	}
}

// InspectGeneration checks whether a workspace generation exists and returns
// its current state.
func (m *Manager) InspectGeneration(ctx context.Context, meta Metadata) (Inspection, error) {
	if m == nil {
		return Inspection{}, fmt.Errorf("workspace manager is nil")
	}

	insp := Inspection{}

	// Check if the worktree path exists
	if meta.Root != "" {
		if fi, err := os.Stat(meta.Root); err == nil && fi.IsDir() {
			insp.Exists = true
			insp.Path = meta.Root
		}
	}

	if !insp.Exists {
		return insp, nil
	}

	if m.git == nil {
		return insp, nil
	}

	// Get branch name
	out, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "--abbrev-ref", "HEAD")
	if err == nil {
		insp.Branch = strings.TrimSpace(string(out))
	}

	// Get HEAD OID
	out, err = m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD")
	if err == nil {
		insp.HeadOID = strings.TrimSpace(string(out))
	}

	// Check dirty state
	out, err = m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+m.emptyHooksDir(), "status", "--porcelain")
	if err == nil {
		insp.Dirty = len(strings.TrimSpace(string(out))) > 0
	}

	return insp, nil
}

// CapturePrepared captures the current state of a prepared workspace as a
// checkpoint, without requiring an event_seq. Returns checkpoint data for
// the ready transaction.
func (m *Manager) CapturePrepared(ctx context.Context, meta Metadata, taskID string) (Checkpoint, error) {
	if m == nil {
		return Checkpoint{}, fmt.Errorf("workspace manager is nil")
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

	hooksDir := m.emptyHooksDir()
	gitArgs := []string{"-c", "core.hooksPath=" + hooksDir, "add", "-A", "--", "."}
	if _, err := m.git.Run(ctx, meta.Root, env, PathListStdoutLimit, gitArgs...); err != nil {
		return Checkpoint{}, fmt.Errorf("checkpoint add: %w", err)
	}

	treeOut, err := m.git.Run(ctx, meta.Root, env, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "write-tree")
	if err != nil {
		return Checkpoint{}, fmt.Errorf("checkpoint write-tree: %w", err)
	}
	treeOID := strings.TrimSpace(string(treeOut))

	headOut, err := m.git.Run(ctx, meta.Root, env, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return Checkpoint{}, fmt.Errorf("checkpoint head: %w", err)
	}
	headOID := strings.TrimSpace(string(headOut))

	return Checkpoint{
		TaskID:    taskID,
		HeadOID:   headOID,
		TreeOID:   treeOID,
		SizeBytes: sizeBytes,
		CreatedAt: m.now().UnixMilli(),
	}, nil
}
