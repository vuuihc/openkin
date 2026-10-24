package node

import (
	"path/filepath"
	"strings"
)

// rootSet is the directories one machine agreed to work in, as they were
// declared.
//
// Two parties on this machine decide whether a path the Hub named is inside
// them: the Executor, before it runs a turn in a directory, and the Responder,
// before it answers a question about one. Those two answering differently is
// not a small bug — a listing that says yes where a dispatch says no offers a
// person a directory that then refuses to run — so the rule lives here once and
// both read it.
type rootSet []string

// declared is the roots as the operator wrote them.
//
// It is what an answer carries: a person recognizes the directory they
// configured, not the path the filesystem resolves it to.
func (rs rootSet) declared() []string {
	if len(rs) == 0 {
		return nil
	}
	out := make([]string, 0, len(rs))
	for _, root := range rs {
		if trimmed := strings.TrimSpace(root); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// resolved is the roots as the filesystem really has them. A root that has been
// renamed or unmounted is left out, which fails closed: work in it is refused.
func (rs rootSet) resolved() []string {
	var out []string
	for _, root := range rs {
		real, err := resolvePath(root)
		if err != nil {
			continue
		}
		out = append(out, real)
	}
	return out
}

// contains reports whether an existing path is inside one of the roots.
//
// The check is containment, not equality: a turn runs in a checkout *inside* a
// root, and a root is what the operator declared. It is decided on the real
// path rather than the written one — a symlink inside a root pointing out of it
// would otherwise carry work out of the boundary while every prefix check still
// said yes — and a path that does not exist is not inside anything.
func (rs rootSet) contains(path string) bool {
	target, err := resolvePath(path)
	if err != nil {
		return false
	}
	return withinRoots(target, rs.resolved())
}

// withinRoots reports whether an already-resolved path is inside one of the
// already-resolved roots.
//
// It is the half of the check that needs nothing from the filesystem, for
// callers that have resolved the path themselves and must not do it twice.
func withinRoots(resolved string, roots []string) bool {
	for _, root := range roots {
		if resolved == root || strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
