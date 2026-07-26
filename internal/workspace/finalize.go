package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FinalizeInspection describes a workspace ready for finalization.
type FinalizeInspection struct {
	HeadOID string
	TreeOID string
	Dirty   bool
}

// InspectFinalizable checks that the workspace is committed and returns
// the current HEAD and tree OIDs. Returns an error if the workspace is dirty.
func (m *Manager) InspectFinalizable(ctx context.Context, meta Metadata) (FinalizeInspection, error) {
	if m == nil {
		return FinalizeInspection{}, fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return FinalizeInspection{}, fmt.Errorf("git runner not available")
	}
	if meta.Mode != ResolvedWorktree {
		return FinalizeInspection{}, fmt.Errorf("%w: cannot finalize shared workspace", ErrNotIsolated)
	}

	// Check that the worktree directory still exists
	if _, err := os.Stat(meta.Root); err != nil {
		return FinalizeInspection{}, fmt.Errorf("workspace root missing: %w", err)
	}

	// Check for uncommitted changes
	out, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit, "-c", "core.hooksPath="+m.emptyHooksDir(), "status", "--porcelain")
	if err != nil {
		return FinalizeInspection{}, fmt.Errorf("check workspace status: %w", err)
	}
	dirty := len(strings.TrimSpace(string(out))) > 0
	if dirty {
		return FinalizeInspection{}, fmt.Errorf("workspace has uncommitted changes")
	}

	// Get HEAD OID
	headOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit, "-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD")
	if err != nil {
		return FinalizeInspection{}, fmt.Errorf("get workspace HEAD: %w", err)
	}
	headOID := strings.TrimSpace(string(headOut))

	// Get tree OID
	treeOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit, "-c", "core.hooksPath="+m.emptyHooksDir(), "rev-parse", "HEAD^{tree}")
	if err != nil {
		return FinalizeInspection{}, fmt.Errorf("get workspace tree: %w", err)
	}
	treeOID := strings.TrimSpace(string(treeOut))

	return FinalizeInspection{
		HeadOID: headOID,
		TreeOID: treeOID,
	}, nil
}

// FinalizeFastForward performs a fast-forward merge of the workspace branch
// into the target branch, then removes the remote tracking reference.
// Returns the resulting merge commit OID.
// The source repository must not be dirty and the merge must be fast-forward.
func (m *Manager) FinalizeFastForward(ctx context.Context, meta Metadata, targetBranch string) (string, error) {
	if m == nil {
		return "", fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return "", fmt.Errorf("git runner not available")
	}

	// Ensure empty hooks dir exists
	hooksDir := m.emptyHooksDir()

	// Get the workspace HEAD before merge
	headOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get workspace HEAD: %w", err)
	}
	wsHead := strings.TrimSpace(string(headOut))

	// Check source is clean
	srcOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "status", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("check source status: %w", err)
	}
	if len(strings.TrimSpace(string(srcOut))) > 0 {
		return "", fmt.Errorf("source repository is dirty")
	}

	// Verify fast-forward possibility
	mergeBase, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "merge-base", "--is-ancestor", wsHead, "HEAD")
	if err != nil {
		// merge-base --is-ancestor exits with 1 if not ancestor
		return "", fmt.Errorf("merge is not fast-forward: workspace HEAD is not ancestor of source HEAD")
	}
	_ = mergeBase

	// Fetch the workspace branch into the source
	wsBranch := meta.Branch
	if wsBranch == "" {
		return "", fmt.Errorf("workspace branch is required")
	}

	// Use git fetch from the worktree to update the source
	_, err = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "fetch", "--no-tags", meta.Root,
		wsBranch+":"+wsBranch)
	if err != nil {
		return "", fmt.Errorf("fetch workspace branch: %w", err)
	}

	// Fast-forward merge
	out, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "merge", "--ff-only", "--no-edit", wsBranch)
	if err != nil {
		return "", fmt.Errorf("fast-forward merge failed: %w", err)
	}
	_ = out

	// Get the merge result OID
	resultOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get merge result: %w", err)
	}
	return strings.TrimSpace(string(resultOut)), nil
}

// RemoveWorktree removes the git worktree and its metadata.
// Returns the path that was removed.
func (m *Manager) RemoveWorktree(ctx context.Context, meta Metadata) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	// Remove the git worktree safely
	hooksDir := m.emptyHooksDir()

	// First try git worktree remove
	_, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "worktree", "remove", "--force", meta.Root)
	if err != nil {
		// If git worktree remove fails, try to remove the directory manually
		_ = os.RemoveAll(meta.Root)

		// Also prune stale worktree metadata
		_, _ = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "worktree", "prune")
	}

	// Remove the branch reference
	if meta.Branch != "" {
		_, _ = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "branch", "-D", meta.Branch)
	}

	return nil
}

// emptyHooksDir returns the path to the empty hooks directory,
// creating it if necessary.
func (m *Manager) emptyHooksDir() string {
	return filepath.Join(m.stateDir, "empty-hooks")
}

// EnsureEmptyHooks creates the empty hooks directory.
func (m *Manager) EnsureEmptyHooks() error {
	dir := m.emptyHooksDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create empty hooks dir: %w", err)
	}
	return nil
}

// Release removes the workspace worktree after finalization.
// Returns the path that was cleaned up.
func (m *Manager) Release(ctx context.Context, meta Metadata) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	if meta.Mode != ResolvedWorktree {
		return fmt.Errorf("%w: cannot release shared workspace", ErrNotIsolated)
	}

	// Remove the worktree
	if err := m.RemoveWorktree(ctx, meta); err != nil {
		return fmt.Errorf("release workspace: %w", err)
	}

	return nil
}

// ReleaseAndPrune removes the worktree and prunes stale checkpoints.
func (m *Manager) ReleaseAndPrune(ctx context.Context, meta Metadata, taskID string) error {
	if err := m.Release(ctx, meta); err != nil {
		return err
	}

	// Clean up checkpoint objects
	checkpointObjects := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	_ = os.RemoveAll(checkpointObjects)

	return nil
}
