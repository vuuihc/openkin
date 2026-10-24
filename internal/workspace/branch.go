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

// CurrentBranch returns the current branch name for the repository at cwd.
// Returns empty string for detached HEAD.
func (m *Manager) CurrentBranch(ctx context.Context, cwd string) (string, error) {
	if m == nil {
		return "", fmt.Errorf("workspace manager is nil")
	}
	abs, err := resolveAbsDir(cwd)
	if err != nil {
		return "", err
	}
	if m.gitPath == "" || m.git == nil {
		return "", fmt.Errorf("git binary not found")
	}
	out, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", fmt.Errorf("resolve current branch: %w", err)
	}
	branch := strings.TrimSpace(string(out))
	if branch == "HEAD" {
		return "", nil
	}
	return branch, nil
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

// CreateBranch starts a new branch in the worktree at cwd and switches to it.
//
// It is not CheckoutBranch with a flag, and the difference is the dirty tree.
// A switch refuses uncommitted work because the work belongs to the branch it
// is on; starting a branch carries it along, because that is what starting a
// branch means and because the uncommitted work is often the whole point — a
// session's changes that nobody has committed yet are what a person publishes.
// Refusing here would leave exactly that work behind on the old branch.
//
// The name must not already exist. Creating a branch that is there is a request
// to move a ref, which is not what any caller of this means.
func (m *Manager) CreateBranch(ctx context.Context, cwd, branch string) error {
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
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "show-ref", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		return fmt.Errorf("branch %q already exists", branch)
	}

	// Prefer `git switch -c` (modern); fall back to checkout if unavailable.
	if _, err := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "switch", "-c", branch); err != nil {
		if _, cerr := m.git.Run(ctx, abs, nil, ControlStdoutLimit, "checkout", "-b", branch); cerr != nil {
			return fmt.Errorf("create branch %q: %w", branch, err)
		}
	}
	return nil
}

// PushBranch puts one branch on origin.
//
// This is the only operation in this package that changes anything outside the
// machine, and there is no force anywhere on it: a branch that would have to
// rewrite what the remote already has is refused by git, and git's refusal is
// the answer — a person who wanted that has not asked for it here.
//
// `--set-upstream` because a branch that does not track origin is one whose
// distance from it a person cannot see in the next turn's status, and seeing
// that is how they know the push landed.
//
// The command is run with the caller's context and without an output bound
// worth the name: a push that succeeded must not be reported as a failure
// because a talkative remote filled a buffer, so the limit is the listing one
// rather than the control one.
func (m *Manager) PushBranch(ctx context.Context, cwd, branch string) error {
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
	if _, err := m.git.Run(ctx, abs, nil, PathListStdoutLimit,
		"push", "--set-upstream", "origin", branch); err != nil {
		return err
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
