// Package toolpath resolves external executables that Kin is willing to run.
//
// It exists because PATH is not trustworthy on a machine that also runs a
// product which installs per-session wrappers. This machine's Kin daemon has
// another product's shim directory injected into its PATH twice, ahead of
// /usr/bin and /opt/homebrew/bin, and a plain exec.LookPath resolves straight
// into it — for `gh`, and for the whole `git-*` family as well.
//
// The wrapper proxies transparently today, which is exactly what makes it worth
// refusing: the failure mode would be decided by another product's behaviour
// rather than by Kin's, on the path that pushes code and reads pull requests.
// The product's own published contract says so too — local projects and their
// worktrees are meant to keep native authentication, not managed wrappers.
//
// So resolution is by absolute path: an explicit override, then the usual
// install locations, then PATH with the refused directories filtered out.
// Judging both the path as given and its symlink target matters, because a
// symlink in an innocent directory pointing into a wrapper directory is
// precisely the substitution this exists to refuse.
package toolpath

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ErrUnavailable means no executable Kin is willing to run was found.
var ErrUnavailable = errors.New("no usable executable found")

// SessionShimComponent is the path component under which the desktop app
// installs a per-session wrapper for a command-line tool.
//
// The wrapper is not the tool. It proxies calls to that product's own service,
// prints its own telemetry, and must not be used for local projects.
const SessionShimComponent = "gh-session-bin"

// stateDirComponent is that product's state directory. Refusing the whole
// directory, not only the shim, means a future layout cannot reintroduce this
// by renaming one folder.
const stateDirComponent = ".lody"

// Spec describes one executable and where to look for it.
type Spec struct {
	// Name is the file name to resolve, e.g. "git".
	Name string
	// EnvVar optionally names an environment variable holding an explicit
	// path, tried before everything else. A value there that is refused or not
	// executable is an error rather than a fallback: someone who set it meant
	// it, and silently running a different binary would be worse.
	EnvVar string
	// Known are absolute candidates in preference order, tried before PATH.
	Known []string
}

// Resolve returns an absolute path to an executable Kin is willing to run, or
// an error wrapping ErrUnavailable that names the places it looked.
//
// Every failure wraps ErrUnavailable, including the ones where a path was named
// and refused: the answer to "is there an executable I can run?" is no in each
// case, and a caller that has to distinguish them can read the message. Two
// sentinels for one outcome would only make the question harder to ask.
func Resolve(spec Spec) (string, error) {
	if spec.EnvVar != "" {
		if override := strings.TrimSpace(os.Getenv(spec.EnvVar)); override != "" {
			resolved, reason := accept(override)
			if reason != "" {
				return "", fmt.Errorf("%w: %s=%s: %s", ErrUnavailable, spec.EnvVar, override, reason)
			}
			return resolved, nil
		}
	}

	searched := append([]string{}, spec.Known...)
	for _, known := range spec.Known {
		if resolved, reason := accept(known); reason == "" {
			return resolved, nil
		}
	}
	if found, ok := fromPath(os.Getenv("PATH"), spec.Name, &searched); ok {
		return found, nil
	}
	return "", fmt.Errorf("%w (looked in %s)", ErrUnavailable, strings.Join(searched, ", "))
}

// accept returns the absolute form of a path Kin is willing to run, or the
// reason it is not.
//
// Absolute is not tidiness. The caller runs the result with a working directory
// of its own choosing — a repository, for git — and os/exec resolves a relative
// Path *after* changing into that directory, so a relative `tools/git` that was
// validated here would execute the repository's own tools/git there instead.
// Measured, not assumed: exec.Cmd{Path: "tools/git", Dir: <repo>} runs
// <repo>/tools/git.
func accept(path string) (string, string) {
	if reason := Refuse(path); reason != "" {
		return "", reason
	}
	if !isExecutableFile(path) {
		return "", "not an executable file"
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", "no absolute form: " + err.Error()
	}
	return abs, ""
}

// fromPath scans PATH for a name Kin is willing to run, appending every
// candidate it considered to searched.
//
// Entries are searched in order, so this only runs after the known install
// locations have failed — a normal install anywhere still works, and PATH
// ordering cannot be used to put a wrapper in front of it.
func fromPath(pathEnv, name string, searched *[]string) (string, bool) {
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" || Refuse(dir) != "" {
			continue
		}
		entry := filepath.Join(dir, name)
		*searched = append(*searched, entry)
		// accept judges the candidate and not only the directory it sits in: a
		// clean directory holding a symlink into a wrapper directory is exactly
		// the substitution this control exists to refuse, and vetoing the
		// directory alone would wave it through.
		if resolved, reason := accept(entry); reason == "" {
			return resolved, true
		}
	}
	return "", false
}

// FilterPATH returns pathEnv with the refused directories removed.
//
// Resolving the binary is only half of it: the tool Kin runs has helpers of its
// own — git shells out to `git-remote-https` and to credential helpers, gh runs
// git — and they are found through the PATH they inherit. An unfiltered PATH
// would let a wrapper back in one level down, which is why the child's
// environment is rewritten rather than only the parent's lookup.
//
// Relative entries go too, for the reason relative answers are refused above:
// the child changes directory, so `bin` is judged here and searched there. What
// this does not cover is a symlink planted in a clean directory under a name
// only the child would look up; there is no fixed list of those names to check.
func FilterPATH(pathEnv string) string {
	var kept []string
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" || !filepath.IsAbs(dir) || Refuse(dir) != "" {
			continue
		}
		kept = append(kept, dir)
	}
	return strings.Join(kept, string(filepath.ListSeparator))
}

// fallbackPATH is used when every entry of PATH was refused. Leaving PATH unset
// would be worse than the thing being defended against: the child fails in a
// way that reads like a bug in it rather than like something Kin did.
const fallbackPATH = "/usr/bin:/bin:/usr/sbin:/sbin"

// dirEnvVars are variables that name a directory a tool searches for its own
// helpers, ahead of PATH.
//
// Rewriting PATH is only as good as the other doors. git takes GIT_EXEC_PATH
// before anything on PATH, so a shim named there survives the rewrite and every
// `git-*` helper is still found through it — which is the arrangement this
// package exists to refuse, since the shim ships the whole family as symlinks.
// A refused value is dropped rather than rewritten: git then falls back to its
// own compiled-in location, which is where its helpers really are.
//
// The rest name a file or program git reads for the same purpose — a
// configuration file, a credential program. They are judged as paths, and only
// a refused one is dropped.
var dirEnvVars = map[string]bool{
	"GIT_EXEC_PATH":     true,
	"GIT_CONFIG":        true,
	"GIT_CONFIG_SYSTEM": true,
	"GIT_CONFIG_GLOBAL": true,
	"GIT_ASKPASS":       true,
}

// injectedConfig reports whether an environment variable belongs to git's
// configuration-in-the-environment family, which arrives as one unit: the count
// bounds the numbered key/value pairs, so dropping a single member would change
// what the remaining ones mean.
func injectedConfig(name string) bool {
	switch name {
	case "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS":
		return true
	}
	return strings.HasPrefix(name, "GIT_CONFIG_KEY_") ||
		strings.HasPrefix(name, "GIT_CONFIG_VALUE_")
}

// namesRefusedProduct reports whether a value carries the fingerprint of the
// refused product.
//
// A substring test, deliberately: these values are not paths. An injected
// credential helper reads `!node "/Users/…/.lody/dsh/helper.js"`, so judging the
// value as a path finds nothing — the directory is inside a command.
func namesRefusedProduct(value string) bool {
	folded := foldCase(value)
	return strings.Contains(folded, foldCase(SessionShimComponent)) ||
		strings.Contains(folded, string(filepath.Separator)+foldCase(stateDirComponent)+string(filepath.Separator))
}

// SanitizeEnv returns env with PATH filtered, ready to hand to a child process.
func SanitizeEnv(env []string) []string {
	// The injected configuration is all-or-nothing, so it is decided before any
	// of it is copied: half of a count-bounded set is a different configuration.
	dropInjected := false
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if ok && injectedConfig(name) && namesRefusedProduct(value) {
			dropInjected = true
			break
		}
	}

	out := make([]string, 0, len(env))
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			out = append(out, entry)
			continue
		}
		if name == "PATH" {
			filtered := FilterPATH(value)
			if filtered == "" {
				filtered = fallbackPATH
			}
			out = append(out, name+"="+filtered)
			continue
		}
		if dropInjected && injectedConfig(name) {
			continue
		}
		// Someone else's GIT_EXEC_PATH is their configuration and is passed
		// through untouched; only one that names a refused directory goes.
		if dirEnvVars[name] && Refuse(value) != "" {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// Refuse returns a human-readable reason to refuse a path, or "" to accept.
//
// Both the path as given and its symlink target are judged. The comparison is
// absolute and, where the platform's filesystem is case-insensitive,
// case-folded — a lexical check that is neither can be spelled past without
// meaning to.
func Refuse(path string) string {
	for _, candidate := range []string{filepath.Clean(path), resolveSymlinks(path)} {
		if candidate == "" {
			continue
		}
		if abs, err := filepath.Abs(candidate); err == nil {
			candidate = abs
		}
		for _, part := range strings.Split(candidate, string(filepath.Separator)) {
			if foldCase(part) == SessionShimComponent {
				return "refusing a per-session wrapper installed by another product; " +
					"local projects are meant to use native authentication"
			}
		}
		if home, err := os.UserHomeDir(); err == nil {
			root := filepath.Join(home, stateDirComponent)
			// Both spellings of the root: a state directory that is itself a
			// symlink — onto another volume, say — would otherwise be compared
			// against paths that have already been resolved, and a binary
			// physically inside it would pass.
			if within(root, candidate) || within(resolveSymlinks(root), candidate) {
				return "refusing a binary inside another product's state directory"
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
