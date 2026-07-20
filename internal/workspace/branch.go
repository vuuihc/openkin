package workspace

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Branch is one local Git branch.
type Branch struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
}

// BranchStatus is the branch listing for a working directory.
type BranchStatus struct {
	Cwd      string   `json:"cwd"`
	IsGit    bool     `json:"is_git"`
	Current  string   `json:"current,omitempty"`
	Detached bool     `json:"detached,omitempty"`
	Dirty    bool     `json:"dirty,omitempty"`
	Branches []Branch `json:"branches"`
	Reason   string   `json:"reason,omitempty"`
}

// local branch names must be non-empty and free of path / control junk.
// Full validation is delegated to `git check-ref-format --branch`.
var branchNameReject = regexp.MustCompile(`[\x00-\x1f\x7f]|^\s|\s$`)

const maxBranchNameLen = 255

// ListBranches reports local branches for cwd (best-effort; non-git returns IsGit=false).
func (m *Manager) ListBranches(ctx context.Context, cwd string) (BranchStatus, error) {
	if m == nil {
		return BranchStatus{}, fmt.Errorf("workspace manager is nil")
	}
	abs, err := resolveAbsDir(cwd)
	if err != nil {
		return BranchStatus{}, err
	}
	res := BranchStatus{
		Cwd:      abs,
		Branches: []Branch{},
	}
	if m.gitPath == "" || m.git == nil {
		res.Reason = "git binary not found"
		return res, nil
	}

	// Confirm repository.
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--git-dir"); err != nil {
		res.Reason = "not a git repository"
		return res, nil
	}
	res.IsGit = true

	// Current branch: empty symbolic-ref means detached HEAD.
	symOut, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		res.Detached = true
		// Still try to show short OID for UI.
		if headOut, herr := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--short", "HEAD"); herr == nil {
			res.Current = strings.TrimSpace(string(headOut))
		}
	} else {
		res.Current = strings.TrimSpace(string(symOut))
	}

	// Dirty detection (same spirit as Probe).
	if statusOut, serr := m.git.Run(ctx, abs, nil, PathListStdoutLimit,
		"status", "--porcelain=v1", "-z", "--untracked-files=normal"); serr == nil {
		res.Dirty = len(statusOut) > 0
	}

	// Local branches only (safe to checkout without creating tracking branches).
	listOut, err := m.git.Run(ctx, abs, nil, PathListStdoutLimit,
		"for-each-ref", "--format=%(refname:short)%00%(HEAD)", "refs/heads")
	if err != nil {
		res.Reason = "failed to list branches"
		return res, nil
	}
	res.Branches = parseBranchList(listOut, res.Current)
	return res, nil
}

func parseBranchList(raw []byte, current string) []Branch {
	if len(raw) == 0 {
		return []Branch{}
	}
	// for-each-ref prints newline-separated records (format fields joined by NUL).
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return []Branch{}
	}
	lines := strings.Split(text, "\n")
	out := make([]Branch, 0, len(lines))
	seen := make(map[string]struct{}, len(lines))
	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		name, headMark, _ := strings.Cut(line, "\x00")
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		cur := headMark == "*" || name == current
		out = append(out, Branch{Name: name, Current: cur})
	}
	return out
}

// CheckoutBranch switches the worktree at cwd to an existing local branch.
// Refuses dirty worktrees and invalid branch names.
func (m *Manager) CheckoutBranch(ctx context.Context, cwd, branch string) error {
	if m == nil {
		return fmt.Errorf("workspace manager is nil")
	}
	if m.gitPath == "" || m.git == nil {
		return ErrGitUnavailable
	}
	branch = strings.TrimSpace(branch)
	if err := validateBranchName(branch); err != nil {
		return err
	}
	abs, err := resolveAbsDir(cwd)
	if err != nil {
		return err
	}

	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--git-dir"); err != nil {
		return ErrNotGit
	}

	// Ensure the branch exists as a local ref before switching.
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); err != nil {
		return fmt.Errorf("branch %q not found", branch)
	}

	// Refuse dirty switches to avoid clobbering user edits.
	statusOut, err := m.git.Run(ctx, abs, nil, PathListStdoutLimit,
		"status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return fmt.Errorf("failed to read worktree status: %w", err)
	}
	if len(statusOut) > 0 {
		return ErrDirtySource
	}

	// Prefer `git switch` (modern); fall back to checkout if unavailable.
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "switch", "--", branch); err != nil {
		if _, cerr := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "checkout", "--", branch); cerr != nil {
			return fmt.Errorf("checkout %q: %w", branch, err)
		}
	}
	return nil
}

func validateBranchName(name string) error {
	if name == "" {
		return fmt.Errorf("branch name is empty")
	}
	if utf8.RuneCountInString(name) > maxBranchNameLen {
		return fmt.Errorf("branch name too long")
	}
	if branchNameReject.MatchString(name) {
		return fmt.Errorf("invalid branch name")
	}
	// Block path tricks and option injection.
	if strings.HasPrefix(name, "-") || strings.Contains(name, "..") || strings.Contains(name, "\\") {
		return fmt.Errorf("invalid branch name")
	}
	// Refuse remote-looking refs and absolute refs — local heads only.
	if strings.HasPrefix(name, "refs/") || strings.Contains(name, ":") {
		return fmt.Errorf("invalid branch name")
	}
	return nil
}
