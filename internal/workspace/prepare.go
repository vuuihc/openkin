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

// ULID Crockford base32, 26 chars (matches store task IDs).
var taskIDPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

// worktreeBranch returns the Kin branch name for a task.
func worktreeBranch(taskID string) string {
	return "kin/task/" + strings.ToLower(taskID)
}

// worktreePath returns stateDir/worktrees/<taskID> after validating taskID.
func (m *Manager) worktreePath(taskID string) (string, error) {
	if !taskIDPattern.MatchString(taskID) {
		return "", fmt.Errorf("%w: %q", ErrInvalidTaskID, taskID)
	}
	// Contain only the validated id under worktrees/.
	return filepath.Join(m.stateDir, "worktrees", taskID), nil
}

// Prepare resolves isolation for a new task and optionally creates a worktree.
func (m *Manager) Prepare(ctx context.Context, taskID, cwd string, requested RequestedMode) (Metadata, error) {
	if m == nil {
		return Metadata{}, fmt.Errorf("workspace manager is nil")
	}
	if requested == "" {
		requested = ModeAuto
	}
	switch requested {
	case ModeAuto, ModeShared, ModeWorktree:
	default:
		return Metadata{}, fmt.Errorf("%w: %q", ErrInvalidMode, requested)
	}

	if !taskIDPattern.MatchString(taskID) {
		return Metadata{}, fmt.Errorf("%w: %q", ErrInvalidTaskID, taskID)
	}

	probe, err := m.Probe(ctx, cwd)
	if err != nil {
		return Metadata{}, err
	}

	sharedMeta := func(reason string) Metadata {
		cwdEff := probe.Cwd
		if cwdEff == "" {
			cwdEff = cwd
		}
		meta := Metadata{
			Mode:       ResolvedShared,
			SourceRoot: probe.SourceRoot,
			Root:       cwdEff,
			Cwd:        cwdEff,
			Scope:      probe.Scope,
			BaseOID:    probe.HeadOID,
			Reason:     reason,
		}
		if meta.Scope == "" {
			meta.Scope = "."
		}
		return meta
	}

	switch requested {
	case ModeShared:
		reason := probe.Reason
		if reason == "" {
			reason = "explicit shared mode"
		}
		return sharedMeta(reason), nil

	case ModeAuto:
		if !probe.CanWorktree || probe.Dirty || !probe.IsGit {
			reason := probe.Reason
			if reason == "" {
				reason = "auto fell back to shared"
			}
			return sharedMeta(reason), nil
		}
		return m.createWorktree(ctx, taskID, probe)

	case ModeWorktree:
		if !probe.GitAvailable {
			return Metadata{}, ErrGitUnavailable
		}
		if !probe.IsGit {
			return Metadata{}, ErrNotGit
		}
		if probe.IsBare {
			return Metadata{}, ErrBareRepository
		}
		if !probe.HasHead {
			return Metadata{}, ErrNoHead
		}
		if !probe.CanWorktree {
			return Metadata{}, ErrNotGit
		}
		// Dirty is allowed for explicit worktree (from committed HEAD).
		return m.createWorktree(ctx, taskID, probe)
	}
	return Metadata{}, fmt.Errorf("%w: %q", ErrInvalidMode, requested)
}

func (m *Manager) createWorktree(ctx context.Context, taskID string, probe ProbeResult) (Metadata, error) {
	wtPath, err := m.worktreePath(taskID)
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

	branch := worktreeBranch(taskID)
	// 30s bound for worktree add.
	addCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// git worktree add -b <branch> <path> <head-oid>
	_, err = m.git.Run(addCtx, probe.SourceRoot, nil, ControlStdoutLimit,
		"worktree", "add", "-b", branch, wtPath, probe.HeadOID)
	if err != nil {
		// Only remove path if we created it and it sits under stateDir/worktrees.
		_ = m.safeRemoveWorktreeDir(wtPath)
		return Metadata{}, err
	}

	// Execution cwd preserves nested scope inside the new worktree.
	execCwd := wtPath
	if probe.Scope != "" && probe.Scope != "." {
		execCwd = filepath.Join(wtPath, filepath.FromSlash(probe.Scope))
	}

	return Metadata{
		Mode:       ResolvedWorktree,
		SourceRoot: probe.SourceRoot,
		Root:       wtPath,
		Cwd:        execCwd,
		Scope:      probe.Scope,
		BaseOID:    probe.HeadOID,
		Branch:     branch,
		Reason:     "isolated worktree",
	}, nil
}

// CleanupPrepared removes a just-created worktree and its Kin branch.
// Only for prepared-but-not-started rollback; not exposed over HTTP.
func (m *Manager) CleanupPrepared(ctx context.Context, taskID string, meta Metadata) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	if meta.Mode != ResolvedWorktree {
		return ErrNotIsolated
	}
	if !taskIDPattern.MatchString(taskID) {
		return fmt.Errorf("%w: %q", ErrInvalidTaskID, taskID)
	}
	wtPath, err := m.worktreePath(taskID)
	if err != nil {
		return err
	}
	// Refuse any path outside stateDir/worktrees or mismatching metadata.
	if err := m.assertWorktreeContained(meta.Root); err != nil {
		return err
	}
	if filepath.Clean(meta.Root) != filepath.Clean(wtPath) {
		return fmt.Errorf("%w: metadata root mismatch", ErrNotIsolated)
	}
	if meta.SourceRoot == "" || meta.Branch == "" {
		return fmt.Errorf("incomplete worktree metadata")
	}

	// worktree remove --force
	_, rmErr := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"worktree", "remove", "--force", meta.Root)
	// Always try to delete the branch even if remove failed (e.g. already gone).
	_, brErr := m.git.Run(ctx, meta.SourceRoot, nil, ControlStdoutLimit,
		"branch", "-D", meta.Branch)
	// Best-effort directory removal if git left residue.
	_ = m.safeRemoveWorktreeDir(meta.Root)

	if rmErr != nil && !os.IsNotExist(rmErr) {
		// If path already absent, treat as success.
		if _, statErr := os.Stat(meta.Root); statErr == nil {
			return rmErr
		}
	}
	if brErr != nil {
		// Branch may already be gone; only fail if remove also failed hard.
		if rmErr != nil {
			return fmt.Errorf("cleanup worktree: %v; branch: %v", rmErr, brErr)
		}
	}
	return nil
}

func (m *Manager) assertWorktreeContained(path string) error {
	clean := filepath.Clean(path)
	root := filepath.Clean(filepath.Join(m.stateDir, "worktrees"))
	rel, err := filepath.Rel(root, clean)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: path %s outside worktrees", ErrNotIsolated, path)
	}
	if rel == "." {
		return fmt.Errorf("%w: path is worktrees root", ErrNotIsolated)
	}
	return nil
}

func (m *Manager) safeRemoveWorktreeDir(path string) error {
	if err := m.assertWorktreeContained(path); err != nil {
		return err
	}
	return os.RemoveAll(path)
}

// Capture is implemented in a later task (private Git tree checkpoints).
func (m *Manager) Capture(ctx context.Context, meta Metadata, taskID string, eventSeq int) (Checkpoint, error) {
	return Checkpoint{}, ErrCheckpointUnavailable
}

// Restore is implemented in a later task.
func (m *Manager) Restore(ctx context.Context, meta Metadata, taskID string, cp Checkpoint) error {
	return ErrCheckpointUnavailable
}

// PrepareFork is implemented in a later task.
func (m *Manager) PrepareFork(ctx context.Context, newTaskID string, source Metadata, cp Checkpoint) (Metadata, error) {
	return Metadata{}, ErrCheckpointUnavailable
}
