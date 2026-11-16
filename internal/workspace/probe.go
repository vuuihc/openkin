package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// resolveAbsDir cleans, absolutizes, and EvalSymlinks a directory path.
func resolveAbsDir(cwd string) (string, error) {
	abs, err := filepath.Abs(filepath.Clean(cwd))
	if err != nil {
		return "", fmt.Errorf("cwd: %w", err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("cwd %s: %w", abs, err)
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("cwd %s: not a directory", abs)
	}
	// Resolve symlinks (e.g. macOS /var -> /private/var) so Rel/Containment work.
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return abs, nil
}

// Probe inspects cwd and reports whether an isolated worktree is possible.
func (m *Manager) Probe(ctx context.Context, cwd string) (ProbeResult, error) {
	if m == nil {
		return ProbeResult{}, fmt.Errorf("workspace manager is nil")
	}
	abs, err := resolveAbsDir(cwd)
	if err != nil {
		return ProbeResult{}, err
	}

	res := ProbeResult{
		Cwd:             abs,
		GitAvailable:    m.gitPath != "" && m.git != nil,
		RecommendedMode: string(ResolvedShared),
	}
	if !res.GitAvailable {
		res.Reason = "git binary not found"
		return res, nil
	}

	// Detect repository presence. Bare repos have no --show-toplevel.
	gitDirOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--git-dir")
	if err != nil {
		res.IsGit = false
		res.Reason = "not a git repository"
		return res, nil
	}
	_ = gitDirOut
	res.IsGit = true

	bareOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--is-bare-repository")
	if err != nil {
		res.Reason = "failed to inspect repository"
		return res, nil
	}
	res.IsBare = strings.TrimSpace(string(bareOut)) == "true"
	if res.IsBare {
		// For bare repos the "root" is the bare directory itself.
		res.SourceRoot = abs
		res.Scope = "."
		res.CanWorktree = false
		res.RecommendedMode = string(ResolvedShared)
		res.Reason = "bare repository"
		return res, nil
	}

	top, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--show-toplevel")
	if err != nil {
		res.IsGit = false
		res.Reason = "not a git repository"
		return res, nil
	}
	sourceRoot := filepath.Clean(strings.TrimSpace(string(top)))
	if resolved, err := filepath.EvalSymlinks(sourceRoot); err == nil {
		sourceRoot = resolved
	}
	res.SourceRoot = sourceRoot

	// Scope relative to source root, slash form; "." at root.
	rel, err := filepath.Rel(sourceRoot, abs)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("scope: %w", err)
	}
	rel = filepath.ToSlash(rel)
	if rel == "" || rel == "." {
		res.Scope = "."
	} else if strings.HasPrefix(rel, "../") || rel == ".." {
		// Path not under toplevel after symlink resolution — treat as root scope.
		res.Scope = "."
	} else {
		res.Scope = rel
	}

	headOut, err := m.git.Run(ctx, sourceRoot, nil, ControlStdoutLimit, "rev-parse", "HEAD")
	if err != nil {
		res.HasHead = false
		res.CanWorktree = false
		res.RecommendedMode = string(ResolvedShared)
		res.Reason = "repository has no HEAD"
		return res, nil
	}
	res.HasHead = true
	res.HeadOID = strings.TrimSpace(string(headOut))
	res.CanWorktree = true

	statusOut, err := m.git.Run(ctx, sourceRoot, nil, PathListStdoutLimit,
		"status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		res.Reason = "failed to read worktree status"
		res.RecommendedMode = string(ResolvedShared)
		return res, nil
	}
	res.Dirty = len(statusOut) > 0
	if res.Dirty {
		res.RecommendedMode = string(ResolvedShared)
		res.Reason = "worktree is dirty"
	} else {
		res.RecommendedMode = string(ResolvedWorktree)
		res.Reason = "clean git worktree"
	}
	return res, nil
}
