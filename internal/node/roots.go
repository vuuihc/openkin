package node

import (
	"strings"

	"github.com/vuuihc/openkin/internal/fsroot"
)

// rootSet is the directories one machine agreed to work in, as they were
// declared.
//
// The rule that decides whether a path is inside them lives in internal/fsroot,
// shared with the Hub's own check on where an account may create work: those two
// answering differently is not a small bug — a listing that says yes where a
// dispatch says no offers a person a directory that then refuses to run — so it
// is one function with two readers rather than two functions that agree today.
// What stays here is what is specific to being a node: the roots as the operator
// wrote them, which is what an answer carries back.
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
	return fsroot.ResolveAll(rs)
}

// contains reports whether an existing path is inside one of the roots.
//
// The check is containment, not equality: a turn runs in a checkout *inside* a
// root, and a root is what the operator declared.
func (rs rootSet) contains(path string) bool {
	return fsroot.Contains(path, rs)
}
