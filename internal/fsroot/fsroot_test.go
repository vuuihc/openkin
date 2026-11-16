package fsroot

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWithinComparesPathSegments(t *testing.T) {
	// Two directories that share a name prefix, which is the case a string
	// prefix check gets wrong. Real directories rather than literals, because
	// the trap is about how a filesystem names things, not about spelling.
	parent := t.TempDir()
	root := filepath.Join(parent, "data")
	sibling := filepath.Join(parent, "data2")
	for _, dir := range []string{root, sibling, filepath.Join(root, "checkout")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	resolvedRoot, err := Resolve(root)
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}

	cases := []struct {
		name   string
		target string
		want   bool
	}{
		{"the root itself", root, true},
		{"inside the root", filepath.Join(root, "checkout"), true},
		{"a sibling sharing a prefix", sibling, false},
		{"the parent", parent, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolved, err := Resolve(tc.target)
			if err != nil {
				t.Fatalf("resolve %s: %v", tc.target, err)
			}
			if got := Within(resolved, []string{resolvedRoot}); got != tc.want {
				t.Fatalf("Within(%s, [%s]) = %v, want %v", resolved, resolvedRoot, got, tc.want)
			}
		})
	}
}

// A symlink inside a declared root that points out of it is how a repository
// carries work past a boundary while every prefix check still says yes. The
// check is therefore decided on the resolved path, and this is the test that
// says so.
func TestContainsFollowsSymlinksOutOfTheRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "elsewhere"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	// A link to a directory that is genuinely inside stays inside, so the
	// refusal below is about where the link points and not about links.
	inside := filepath.Join(root, "checkout")
	if err := os.Mkdir(inside, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.Symlink(inside, filepath.Join(root, "shortcut")); err != nil {
		t.Fatalf("symlink inside: %v", err)
	}

	if Contains(link, []string{root}) {
		t.Fatal("a symlink pointing out of the root is contained by it; a repository can carry work past the boundary")
	}
	if Contains(filepath.Join(link, "elsewhere"), []string{root}) {
		t.Fatal("a path reached through a symlink out of the root is contained by it")
	}
	if !Contains(filepath.Join(root, "shortcut"), []string{root}) {
		t.Fatal("a symlink to a directory inside the root is not contained by it")
	}
}

func TestContainsRefusesWhatItCannotResolve(t *testing.T) {
	root := t.TempDir()
	if Contains(filepath.Join(root, "not-there"), []string{root}) {
		t.Fatal("a path that does not exist is contained by the root")
	}
	// An empty declaration is not "anywhere". This is the direction that matters:
	// read the other way, a machine with no roots declared would accept work
	// anywhere on it.
	if Contains(root, nil) {
		t.Fatal("a path is contained by an empty set of roots")
	}
}

// A blank declaration must not become a root. filepath.Abs("") answers the
// process's working directory, so resolving one would authorize wherever the
// daemon happened to be started -- a directory nobody named. The list builders
// filter blanks before they get here, which is why this is asserted on the
// function rather than through a builder: the next caller passes a different
// list.
func TestABlankDeclarationIsNotARoot(t *testing.T) {
	root := t.TempDir()
	for _, blank := range []string{"", "   ", "\t"} {
		if got := ResolveAll([]string{blank}); len(got) != 0 {
			t.Fatalf("ResolveAll(%q) = %v, want no roots; a blank became the working directory", blank, got)
		}
		if Contains(root, []string{blank}) {
			t.Fatalf("Contains(%s, [%q]) = true; a blank declaration authorized a directory", root, blank)
		}
	}
	// And the working directory itself is not authorized by a blank, which is the
	// concrete form of the same failure.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if Contains(wd, []string{""}) {
		t.Fatalf("a blank declaration authorized the working directory %s", wd)
	}
	if _, err := Resolve(""); err == nil {
		t.Fatal("Resolve(\"\") succeeded; it answers the working directory")
	}
}

// A root that has been renamed or unmounted has to fail closed. Skipping it is
// what does that, and a caller that wants to say so out loud compares the result
// against what it declared -- which is only possible if nothing is invented for
// a root that is not there.
func TestResolveAllSkipsRootsThatAreNotThere(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "unmounted")
	got := ResolveAll([]string{root, missing, ""})
	if len(got) != 1 {
		t.Fatalf("ResolveAll kept %d roots, want only the one that resolves: %v", len(got), got)
	}
	resolvedRoot, err := Resolve(root)
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	if got[0] != resolvedRoot {
		t.Fatalf("ResolveAll kept %q, want the resolved root %q", got[0], resolvedRoot)
	}
	if len(ResolveAll(nil)) != 0 {
		t.Fatal("ResolveAll invented a root from an empty declaration")
	}
}
