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

// helperEnvVars are variables that name a directory, a file, or a program git
// uses for an operation of its own, ahead of anything PATH would say.
//
// Rewriting PATH is only as good as the other doors. git takes GIT_EXEC_PATH
// before anything on PATH, so a shim named there survives the rewrite and every
// `git-*` helper is still found through it — which is the arrangement this
// package exists to refuse, since the shim ships the whole family as symlinks.
//
// The rest name a program or a configuration file. The push path is why they
// are here: git runs GIT_SSH, or the shell command in GIT_SSH_COMMAND, to reach
// a remote, with GIT_PROXY_COMMAND and SSH_ASKPASS on the way, and GIT_ASKPASS
// to answer a credential prompt. A wrapper named in any of them is executed for
// every push, on the same path that carries code. GIT_CONFIG and its system and
// global siblings point git at a file that can name a helper of its own.
//
// A refused value is dropped rather than rewritten: git then falls back to its
// own compiled-in location, to plain ssh, or to no configuration file at all,
// which is where those really are.
var helperEnvVars = map[string]bool{
	"GIT_EXEC_PATH":     true,
	"GIT_CONFIG":        true,
	"GIT_CONFIG_SYSTEM": true,
	"GIT_CONFIG_GLOBAL": true,
	"GIT_ASKPASS":       true,
	"GIT_SSH":           true,
	"GIT_SSH_COMMAND":   true,
	"GIT_PROXY_COMMAND": true,
	"SSH_ASKPASS":       true,
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
// refused product, read as text rather than as a path.
//
// A substring and component test, deliberately: these values are not paths. An
// injected credential helper reads `!node "/Users/…/.lody/dsh/helper.js"`, so
// judging the value as a path finds nothing — the directory is inside a command.
// Matching the state directory as a whole component, rather than only between
// two separators, is what catches the spellings that carry no trailing
// separator: a relative `.lody/bin`, or the directory itself.
func namesRefusedProduct(value string) bool {
	folded := foldCase(value)
	if strings.Contains(folded, foldCase(SessionShimComponent)) {
		return true
	}
	for _, part := range strings.Split(folded, string(filepath.Separator)) {
		if part == foldCase(stateDirComponent) {
			return true
		}
	}
	return false
}

// helperValueRefused reports whether the value of one of helperEnvVars names
// the refused product, judging it as the shell would spell it and as text.
//
// The two tests are not the same test, and neither alone is enough. A leading ~
// is the shell's way of writing the home directory, and filepath.Abs resolves it
// against the working directory instead — so it is expanded first, or a refused
// path written the way a user writes one passes a purely lexical check. That
// same working directory is why the path test is limited to absolute values:
// several of these variables hold a command line rather than a path —
// GIT_SSH_COMMAND is `ssh -i key` — and resolving that against Kin's own
// directory judges a place the child will never look. A relative value is
// therefore read as text, which is what catches one naming the product.
func helperValueRefused(value string) bool {
	if expanded := expandHome(value); filepath.IsAbs(expanded) {
		if Refuse(expanded) != "" {
			return true
		}
	}
	return namesRefusedProduct(value)
}

// expandHome resolves a leading ~ or ~/ against the home directory, the way a
// shell and git's own path handling do. Everything else is returned as given:
// there is no other spelling rule that can be applied without guessing.
func expandHome(value string) string {
	if value != "~" && !strings.HasPrefix(value, "~/") {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return value
	}
	if value == "~" {
		return home
	}
	return filepath.Join(home, value[len("~/"):])
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
		// Someone else's GIT_EXEC_PATH or GIT_SSH_COMMAND is their configuration
		// and is passed through untouched; only one that names the refused
		// product goes.
		if helperEnvVars[name] && helperValueRefused(value) {
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
