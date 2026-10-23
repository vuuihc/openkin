// Package github reads pull-request state for a repository Kin already knows
// about, using credentials that are already on the machine.
//
// The package holds no token and never asks the user for one. It runs the
// user's own GitHub CLI when one it is willing to run exists, and otherwise
// falls back to unauthenticated reads of the public API. Both paths are
// read-only; publishing lives in publish.go and is deliberately not reachable
// from here.
package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Environment variable naming a gh binary to use, ahead of every search path.
const ghPathEnv = "KIN_GH_PATH"

// sessionShimComponent is the path component under which the LODY desktop app
// installs a per-session `gh` wrapper.
//
// That wrapper is not the GitHub CLI. It proxies calls to LODY's own service,
// prints its own telemetry on stdout, and — by the app's own published contract
// — must not be used for local projects: "Local projects and their worktrees
// retain native authentication… Do not install managed wrappers, broker
// contexts or tokens in these sessions."
//
// It matters because it is not hypothetical: the wrapper directory is injected
// into this machine's Kin daemon PATH, twice, ahead of /opt/homebrew/bin. A
// plain exec.Command("gh") from the daemon would run it. So Kin resolves gh by
// absolute path and refuses anything under that component.
const sessionShimComponent = "gh-session-bin"

// lodyStateDirComponent is the desktop app's state directory. Refusing the whole
// directory, not just the shim, means a future layout cannot reintroduce this
// by renaming one folder.
const lodyStateDirComponent = ".lody"

var (
	// ErrGHUnavailable means no gh binary Kin is willing to run was found.
	ErrGHUnavailable = errors.New("no usable gh CLI found")
	// ErrNotAuthenticated means gh exists but has no working credential.
	ErrNotAuthenticated = errors.New("gh is not authenticated")
	// ErrNotFound means the repository or pull request is not visible to the
	// credentials in use. For anonymous reads this also covers private repos,
	// which is why it must not be read as "does not exist".
	ErrNotFound = errors.New("not found or not visible")
	// ErrRateLimited means the forge refused the request for quota reasons.
	ErrRateLimited = errors.New("github rate limit reached")
)

// GHBinary is a resolved, trusted path to the GitHub CLI.
type GHBinary struct {
	Path string
}

// ResolveGH locates a gh binary Kin is willing to run.
//
// Order: an explicit KIN_GH_PATH, then the usual install locations, then PATH
// with the rejected directories filtered out. The PATH scan is last so that a
// normal install anywhere still works, and filtered so that ordering cannot be
// used to substitute a wrapper.
func ResolveGH() (GHBinary, error) {
	if override := strings.TrimSpace(os.Getenv(ghPathEnv)); override != "" {
		if reason := rejectGHPath(override); reason != "" {
			return GHBinary{}, fmt.Errorf("%s=%s: %s", ghPathEnv, override, reason)
		}
		if isExecutableFile(override) {
			return GHBinary{Path: override}, nil
		}
		return GHBinary{}, fmt.Errorf("%s=%s: not an executable file", ghPathEnv, override)
	}

	searched := knownGHLocations()
	for _, candidate := range searched {
		if rejectGHPath(candidate) != "" || !isExecutableFile(candidate) {
			continue
		}
		return GHBinary{Path: candidate}, nil
	}
	if bin, found := resolveFromPath(os.Getenv("PATH"), &searched); found {
		return bin, nil
	}
	return GHBinary{}, fmt.Errorf("%w (looked in %s)", ErrGHUnavailable, strings.Join(searched, ", "))
}

// resolveFromPath scans PATH for a gh Kin is willing to run, appending every
// candidate it considered to searched.
//
// Entries are searched in order, so this only runs after the known install
// locations have failed — a normal install anywhere still works, and PATH
// ordering cannot be used to put a wrapper in front of it.
func resolveFromPath(pathEnv string, searched *[]string) (GHBinary, bool) {
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" || rejectGHPath(dir) != "" {
			continue
		}
		candidate := filepath.Join(dir, "gh")
		*searched = append(*searched, candidate)
		if !isExecutableFile(candidate) {
			continue
		}
		// The candidate is judged, not only the directory it sits in: a `gh` in
		// a clean directory that is a symlink into a wrapper directory is
		// precisely the substitution this control exists to refuse, and vetoing
		// the directory alone would wave it through.
		if rejectGHPath(candidate) != "" {
			continue
		}
		return GHBinary{Path: candidate}, true
	}
	return GHBinary{}, false
}

func knownGHLocations() []string {
	paths := []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"}
	if home, err := os.UserHomeDir(); err == nil {
		paths = append(paths, filepath.Join(home, ".local", "bin", "gh"))
	}
	return paths
}

// rejectGHPath returns a human-readable reason to refuse a path, or "" to accept.
//
// Both the path as given and its symlink target are judged: a symlink in a
// clean directory pointing into a wrapper directory would otherwise pass. The
// comparison is absolute and, where the platform's filesystem is
// case-insensitive, case-folded — a lexical check that is neither can be spelled
// past without meaning to.
func rejectGHPath(path string) string {
	for _, candidate := range []string{filepath.Clean(path), resolveSymlinks(path)} {
		if candidate == "" {
			continue
		}
		if abs, err := filepath.Abs(candidate); err == nil {
			candidate = abs
		}
		for _, part := range strings.Split(candidate, string(filepath.Separator)) {
			if foldCase(part) == sessionShimComponent {
				return "refusing a per-session gh wrapper installed by another product; " +
					"local projects are meant to use native authentication"
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			if within(filepath.Join(home, lodyStateDirComponent), candidate) {
				return "refusing a gh inside another product's state directory"
			}
		}
	}
	return ""
}

// foldCase lowercases a path component on platforms whose filesystem is
// case-insensitive, so that `.LODY` cannot be spelled past a check for `.lody`.
// On a case-sensitive platform the two names really are different directories,
// and folding them would refuse an innocent one.
func foldCase(s string) string {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return strings.ToLower(s)
	}
	return s
}

func resolveSymlinks(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return ""
	}
	return resolved
}

// within reports whether path is root itself or sits underneath it.
func within(root, path string) bool {
	rel, err := filepath.Rel(foldCase(root), foldCase(path))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

// ghTimeout bounds a single gh invocation. Reading a pull request is a small
// request; anything slower is a network problem, not a slow answer.
const ghTimeout = 30 * time.Second

// ghOutputLimit caps captured stdout. Lists are bounded by --paginate limits at
// the call sites; this is the backstop.
const ghOutputLimit int64 = 8 * 1024 * 1024

const ghStderrCap int64 = 8 * 1024

// GHClient runs the resolved gh binary.
type GHClient struct {
	Bin     GHBinary
	Timeout time.Duration
}

// Run executes `gh args...` with argv only, never a shell.
//
// The child environment keeps the user's own gh configuration and credentials —
// that is the point of using their CLI — but the session-shim directories are
// stripped from PATH so that anything gh itself shells out to cannot pick the
// wrapper up either.
func (c GHClient) Run(ctx context.Context, args ...string) ([]byte, error) {
	if c.Bin.Path == "" {
		return nil, ErrGHUnavailable
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = ghTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, c.Bin.Path, args...)
	cmd.Env = ghEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitWriter{w: &stdout, n: ghOutputLimit + 1}
	cmd.Stderr = &limitWriter{w: &stderr, n: ghStderrCap + 1}

	err := cmd.Run()
	out := stdout.Bytes()
	if int64(len(out)) > ghOutputLimit {
		return nil, fmt.Errorf("gh %s: output exceeded %d bytes", strings.Join(args, " "), ghOutputLimit)
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), context.DeadlineExceeded)
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, fmt.Errorf("gh %s: %w", strings.Join(args, " "), context.Canceled)
		}
		msg := strings.TrimSpace(string(capBytes(stderr.Bytes(), ghStderrCap)))
		if msg == "" {
			msg = err.Error()
		}
		return out, classifyGHError(msg)
	}
	return out, nil
}

// ghEnv builds the child environment: the user's, minus wrapper directories,
// plus the settings that keep gh non-interactive and machine-readable.
func ghEnv() []string {
	env := os.Environ()
	out := make([]string, 0, len(env)+6)
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			out = append(out, entry)
			continue
		}
		if name == "PATH" {
			filtered := filterShimFromPath(value)
			if filtered == "" {
				// Every entry was filtered out. Leaving PATH unset would be worse
				// than the thing being defended against: gh runs git and other
				// helpers of its own, and with no PATH it fails in a way that
				// reads like a gh bug.
				filtered = "/usr/bin:/bin:/usr/sbin:/sbin"
			}
			out = append(out, name+"="+filtered)
			continue
		}
		out = append(out, entry)
	}
	return append(out,
		"GH_PROMPT_DISABLED=1",
		"GH_NO_UPDATE_NOTIFIER=1",
		"GH_PAGER=cat",
		"GH_HOST=github.com",
		"NO_COLOR=1",
		"CLICOLOR=0",
	)
}

func filterShimFromPath(path string) string {
	var kept []string
	for _, dir := range filepath.SplitList(path) {
		if dir == "" || rejectGHPath(dir) != "" {
			continue
		}
		kept = append(kept, dir)
	}
	return strings.Join(kept, string(filepath.ListSeparator))
}

// httpStatusRe matches the "(HTTP 404)" suffix gh appends to API errors. The
// number is the part worth trusting; the message around it is not stable.
var httpStatusRe = regexp.MustCompile(`\(HTTP (\d{3})\)`)

// classifyGHError turns gh's stderr into one of the sentinel errors.
//
// gh does not expose a machine-readable failure code, so this reads its text:
// the HTTP status when it printed one, and otherwise the few messages that mean
// "you are not logged in". Anything unrecognized stays a plain error, so a new
// gh release degrades to "we could not read this" rather than being misfiled as
// an empty answer.
func classifyGHError(stderr string) error {
	if m := httpStatusRe.FindStringSubmatch(stderr); m != nil {
		if code, err := strconv.Atoi(m[1]); err == nil {
			switch {
			case code == 401:
				return fmt.Errorf("%w: %s", ErrNotAuthenticated, stderr)
			case code == 403:
				return fmt.Errorf("%w: %s", ErrRateLimited, stderr)
			case code == 404:
				return fmt.Errorf("%w: %s", ErrNotFound, stderr)
			}
		}
	}
	lower := strings.ToLower(stderr)
	for _, hint := range []string{
		"gh auth login",
		"authentication required",
		"not logged in",
		"bad credentials",
		"http 401",
	} {
		if strings.Contains(lower, hint) {
			return fmt.Errorf("%w: %s", ErrNotAuthenticated, stderr)
		}
	}
	return errors.New(stderr)
}

type limitWriter struct {
	w io.Writer
	n int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n <= 0 {
		return len(p), nil
	}
	if int64(len(p)) > l.n {
		p = p[:l.n]
	}
	n, err := l.w.Write(p)
	l.n -= int64(n)
	return n, err
}

func capBytes(b []byte, limit int64) []byte {
	if int64(len(b)) <= limit {
		return b
	}
	return b[:limit]
}
