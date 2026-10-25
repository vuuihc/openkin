// Package fsroot answers one question: is this directory inside one of the
// directories a machine agreed to work in?
//
// It is a package of its own because two layers ask it about two different root
// sets. The node asks whether it will accept work dispatched at a path, before
// it runs a turn there; the task engine asks whether an account may create work
// at one. Those are the same rule over different declarations, and a rule copied
// into two packages is a rule that drifts — here the drift is a boundary in both
// directions at once: one copy saying yes where the other says no either refuses
// work the operator offered, or runs a turn outside the directories they
// declared.
//
// What deliberately does *not* live here is the Hub's matching of paths a device
// reported, which sits in internal/store. Those name directories on another
// machine, so they cannot be resolved against this filesystem at all; that code
// answers a question about text, and this package answers one about a
// filesystem. Keeping them apart is the point, not an oversight.
package fsroot

import (
	"errors"
	"path/filepath"
	"strings"
)

// Resolve returns path with every symlink along it followed.
//
// Containment has to be decided on the real path rather than the written one: a
// symlink inside a declared root that points outside it — a link checked into a
// repository, say — would otherwise carry a turn out of the root while every
// prefix check still said yes. The path has to exist to be resolved, which costs
// nothing: an agent cannot be started in a directory that is not there.
//
// A blank path is refused rather than resolved. filepath.Abs("") answers the
// process's own working directory, so resolving one would turn an empty
// declaration into wherever the daemon happens to have been started — a
// directory nobody named, authorized by omission.
func Resolve(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "", errors.New("fsroot: empty path")
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return filepath.Clean(real), nil
}

// ResolveAll returns roots as the filesystem really has them.
//
// A root that has been renamed or unmounted is left out, which fails closed:
// work in it is refused. Callers that want to say so out loud compare the result
// against what they declared.
//
// A blank entry is dropped for the same reason Resolve refuses one. Callers do
// filter these before they arrive, and that is exactly why this does too: the
// guard belongs where the answer is produced, not only where the list was built,
// because the next caller of this function is a different list.
func ResolveAll(roots []string) []string {
	var out []string
	for _, root := range roots {
		real, err := Resolve(root)
		if err != nil {
			continue
		}
		out = append(out, real)
	}
	return out
}

// Within reports whether an already-resolved path is inside one of the
// already-resolved roots.
//
// It is the half of the check that needs nothing from the filesystem, for
// callers that have resolved the path themselves and must not do it twice.
//
// The comparison is by path segment rather than by string prefix: /srv/data2
// does not begin with /srv/data as a directory, and a prefix check would say it
// did. The separator is appended rather than trimmed from the path so that a
// root which is itself the answer still matches.
func Within(resolved string, roots []string) bool {
	for _, root := range roots {
		if resolved == root || strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// Contains resolves path and reports whether it is inside one of the declared
// roots, which are resolved here too.
//
// It is the whole check for callers that have only the written path. A path that
// does not exist is not inside anything, because it cannot be resolved — which
// is the answer for a typo and for a directory that has gone away alike.
func Contains(path string, roots []string) bool {
	target, err := Resolve(path)
	if err != nil {
		return false
	}
	return Within(target, ResolveAll(roots))
}
