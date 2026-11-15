package hub_test

import (
	"os/exec"
	"strings"
	"testing"
)

const modulePrefix = "github.com/vuuihc/openkin/"

// listImports returns the packages pkg imports, by asking the toolchain rather
// than by reading files. A hand-written scanner has to know every spelling an
// import can take; `go list` is the compiler's own answer.
//
// Test files are excluded, which is the intent: they do not propagate to
// anything that links the package, so they cannot drag a dependency into a
// binary. Where a test imports across a boundary on purpose, the rule below
// says so in a comment instead of leaving a reader to discover it.
func listImports(t *testing.T, pkg string) []string {
	t.Helper()
	out, err := exec.Command("go", "list", "-f", "{{join .Imports \"\\n\"}}", pkg).Output()
	if err != nil {
		var stderr string
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = strings.TrimSpace(string(ee.Stderr))
		}
		t.Fatalf("go list %s: %v\n%s", pkg, err, stderr)
	}
	var imports []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			imports = append(imports, line)
		}
	}
	return imports
}

func moduleImports(t *testing.T, pkg string) []string {
	t.Helper()
	var inModule []string
	for _, imp := range listImports(t, pkg) {
		if strings.HasPrefix(imp, modulePrefix) {
			inModule = append(inModule, imp)
		}
	}
	return inModule
}

// TestProtocolPackageIsALeaf enforces ADR 0025 D5: internal/remote/worker is
// the Hub↔Node wire specification, both sides import it, and it must not
// acquire a dependency on either side's internals.
//
// The rule is about the package, not its tests. internal/remote/worker's own
// tests do import internal/store, to check that the protocol's approval
// decisions and the store's agree — a cross-check worth keeping, and one that
// costs nothing at link time because test imports do not propagate. It would
// have to move if the protocol ever becomes a module of its own.
func TestProtocolPackageIsALeaf(t *testing.T) {
	const pkg = modulePrefix + "internal/remote/worker"
	if got := moduleImports(t, pkg); len(got) > 0 {
		t.Fatalf("%s must import nothing else in this module (ADR 0025 D5), but imports:\n  %s",
			pkg, strings.Join(got, "\n  "))
	}
}
