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

// InspectIntegrationTarget checks that the source repository is on the target
// branch, is clean, and returns the current source HEAD as review_base_oid.
func (m *Manager) InspectIntegrationTarget(ctx context.Context, meta Metadata, targetBranch string) (reviewBaseOID string, err error) {
	if m == nil {
		return "", fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return "", fmt.Errorf("git runner not available")
	}

	hooksDir := m.emptyHooksDir()

	// Check source is clean
	srcOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "status", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("check source status: %w", err)
	}
	if len(strings.TrimSpace(string(srcOut))) > 0 {
		return "", fmt.Errorf("source repository is dirty")
	}

	// Check source is on the target branch
	branchOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get source branch: %w", err)
	}
	currentBranch := strings.TrimSpace(string(branchOut))
	if currentBranch != targetBranch {
		return "", fmt.Errorf("source is on branch %q, expected %q", currentBranch, targetBranch)
	}

	// Get source HEAD
	headOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get source HEAD: %w", err)
	}

	return strings.TrimSpace(string(headOut)), nil
}

// FastForward performs a fast-forward merge of the workspace into the source.
// targetBranch: the source branch to merge into.
// expectedSourceOID: the source HEAD expected before merge (review_base_oid).
// finalHeadOID: the workspace HEAD to merge (must match current workspace tip).
// Returns the resulting merge commit OID.
func (m *Manager) FastForward(ctx context.Context, meta Metadata, targetBranch, expectedSourceOID, finalHeadOID string) (integratedOID string, err error) {
	if m == nil {
		return "", fmt.Errorf("workspace manager is nil")
	}
	if m.git == nil {
		return "", fmt.Errorf("git runner not available")
	}

	hooksDir := m.emptyHooksDir()

	// Verify workspace branch tip still equals finalHeadOID
	wsHeadOut, err := m.git.Run(ctx, meta.Root, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get workspace HEAD: %w", err)
	}
	wsHead := strings.TrimSpace(string(wsHeadOut))
	if wsHead != finalHeadOID {
		return "", fmt.Errorf("workspace HEAD changed after snapshot: expected %s, got %s", finalHeadOID, wsHead)
	}

	// Check source is clean
	srcOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "status", "--porcelain")
	if err != nil {
		return "", fmt.Errorf("check source status: %w", err)
	}
	if len(strings.TrimSpace(string(srcOut))) > 0 {
		return "", fmt.Errorf("source repository is dirty")
	}

	// Verify source HEAD equals expectedSourceOID
	srcHeadOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get source HEAD: %w", err)
	}
	srcHead := strings.TrimSpace(string(srcHeadOut))
	if srcHead != expectedSourceOID {
		return "", fmt.Errorf("source HEAD changed: expected %s, got %s", expectedSourceOID, srcHead)
	}

	// Verify fast-forward possibility: source HEAD must be ancestor of workspace HEAD
	_, err = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "merge-base", "--is-ancestor", srcHead, finalHeadOID)
	if err != nil {
		return "", fmt.Errorf("merge is not fast-forward: source HEAD is not ancestor of workspace HEAD")
	}

	// Fast-forward merge using the exact OID.
	// The OID is reachable from the shared object database (worktrees share objects).
	_, err = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "merge", "--ff-only", "--no-edit", finalHeadOID)
	if err != nil {
		return "", fmt.Errorf("fast-forward merge failed: %w", err)
	}

	// Get the merge result OID
	resultOut, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "rev-parse", "HEAD")
	if err != nil {
		return "", fmt.Errorf("get merge result: %w", err)
	}
	return strings.TrimSpace(string(resultOut)), nil
}

// FinalizeFastForward is a convenience wrapper that inspects the workspace
// and performs a fast-forward merge. Kept for backward compatibility.
func (m *Manager) FinalizeFastForward(ctx context.Context, meta Metadata, targetBranch string) (string, error) {
	insp, err := m.InspectFinalizable(ctx, meta)
	if err != nil {
		return "", fmt.Errorf("inspect finalizable: %w", err)
	}

	reviewBase, err := m.InspectIntegrationTarget(ctx, meta, targetBranch)
	if err != nil {
		return "", fmt.Errorf("inspect integration target: %w", err)
	}

	return m.FastForward(ctx, meta, targetBranch, reviewBase, insp.HeadOID)
}

// RemoveWorktree removes the git worktree and its metadata.
func (m *Manager) RemoveWorktree(ctx context.Context, meta Metadata) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	hooksDir := m.emptyHooksDir()

	_, err := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"-c", "core.hooksPath="+hooksDir, "worktree", "remove", "--force", meta.Root)
	if err != nil {
		_ = os.RemoveAll(meta.Root)
		_, _ = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "worktree", "prune")
	}

	if meta.Branch != "" {
		_, _ = m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
			"-c", "core.hooksPath="+hooksDir, "branch", "-D", meta.Branch)
	}

	return nil
}

// emptyHooksDir returns the path to the empty hooks directory.
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
func (m *Manager) Release(ctx context.Context, meta Metadata) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	if meta.Mode != ResolvedWorktree {
		return fmt.Errorf("%w: cannot release shared workspace", ErrNotIsolated)
	}

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

	checkpointObjects := filepath.Join(m.stateDir, "checkpoints", taskID, "objects")
	_ = os.RemoveAll(checkpointObjects)

	return nil
}
